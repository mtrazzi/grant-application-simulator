import * as vscode from 'vscode';
import Anthropic from "@anthropic-ai/sdk";
import { getResearcherResponse, synthesizeDiscussion, simulateGrantmakerDebate } from './extension';
import { marked } from 'marked';

interface FeedbackConfig {
  researchers: string[];
  systemPrompt: string;
  title: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _anthropic: Anthropic;
    private abortController: AbortController | null = null;

    constructor(private readonly _extensionUri: vscode.Uri, apiKey: string) {
      this._anthropic = new Anthropic({ apiKey });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'getGrantmakingAdvice':
                    await this.handleFeedback(this.grantmakingConfig);
                    break;
                case 'getResearchMethodologyAdvice':
                    await this.handleFeedback(this.researchMethodologyConfig);
                    break;
                case 'startDebaterSelection':
                    this.selectedDebaters = [];
                    await this.handleDebaterSelection();
                    break;
                case 'stopProcess':
                    this.stopOngoingProcess();
                    break;
            }
        });
    }

    private grantmakingConfig: FeedbackConfig = {
        researchers: ['Evan Hubinger', 'Adam Gleave', 'Oliver Habryka', 'Austin Chen'],
        systemPrompt: "You are evaluating a grant proposal for AI alignment research. Provide concise, constructive feedback focusing on the proposal's potential impact, feasibility, and alignment with current priorities in the field. Be specific and actionable in your critique.",
        title: "Grantmaking Advice"
    };

    private researchMethodologyConfig: FeedbackConfig = {
        researchers: ['Ethan Perez', 'Rohin Shah', 'Paul Christiano'],
        systemPrompt: "You are providing feedback on an AI alignment research methodology. Focus on how to improve the approach to make significant progress in alignment research. Consider aspects such as experiment design, theoretical foundations, and potential impact on the field. Please give actual critiques about the feasibility of the approach, and how it would actually lead to more impactful AI Alignment research being produced down the line, say papers published at conferences, or progress being made to reduce existential risk.",
        title: "Research Methodology Advice"
    };

    private updateStatus(status: 'ok' | 'warning' | 'error', message: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'updateStatus', status, message });
        }
    }

    private async handleFeedback(config: FeedbackConfig) {
        this.abortController = new AbortController();
        this.updateLoadingState(true);
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          this.updateFeedback('No active text editor found');
          this.updateLoadingState(false);
          return;
        }

        const selection = editor.selection;
        const text = editor.document.getText(selection);

        if (!text) {
          this.updateFeedback('No text selected');
          this.updateLoadingState(false);
          this.abortController = null;

          return;
        }

        try {
            this.updateStatus('warning', 'Fetching researcher responses...');
            const responses = await Promise.all(config.researchers.map(name =>
                this.getResearcherResponseWithAbort(name, text, config.systemPrompt)
            ));
            this.updateStatus('warning', 'Synthesizing discussion...');
            const summary = await this.synthesizeDiscussionWithAbort(responses, config.researchers, config.title);
            const htmlContent = await marked(summary);
            this.updateStatus('ok', 'Process completed successfully!');


            this.updateFeedback(htmlContent);
        } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
                this.updateStatus('warning', 'Process was stopped by the user.');
        } else {let errorMessage = 'An unknown error occurred';
          if (error instanceof Error) {
            errorMessage = error.message;
          } else if (typeof error === 'string') {
            errorMessage = error;
          }
          this.updateStatus('error', `An error occurred: ${errorMessage}`);
        }
        } finally {
          this.updateLoadingState(false);
          this.abortController = null;
        }
      }

      private async getResearcherResponseWithAbort(researcher: string, text: string, systemPrompt: string): Promise<string> {
        if (this.abortController?.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        return await getResearcherResponse(this._anthropic, researcher, text, systemPrompt, this.abortController!.signal);
    }


    private async synthesizeDiscussionWithAbort(responses: string[], researcherNames: string[], title: string): Promise<string> {
        if (this.abortController?.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        return await synthesizeDiscussion(this._anthropic, responses, researcherNames, title);
    }

      private selectedDebaters: string[] = [];

      private async handleDebaterSelection() {
        const debaters = ['Evan Hubinger', 'Austin Chen', 'Oliver Habryka', 'Adam Gleave'].filter(d => !this.selectedDebaters.includes(d));
        const selectedDebater = await vscode.window.showQuickPick(debaters, {
            placeHolder: `Select debater ${this.selectedDebaters.length + 1} (${this.selectedDebaters.length + 1}/2)`,
        });

        if (selectedDebater) {
            this.selectedDebaters.push(selectedDebater);
            if (this._view) {
                this._view.webview.postMessage({ type: 'debaterSelected', debater: selectedDebater });
            }
            if (this.selectedDebaters.length < 2) {
                await this.handleDebaterSelection();
            } else {
                await this.handleGrantmakerDebate();
            }
        }
    }

    private async handleGrantmakerDebate() {
        this.abortController = new AbortController();
        this.updateLoadingState(true);
        this.updateStatus('ok', 'Starting grantmaker debate...');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.updateStatus('error', 'No active text editor found. Please open a file and try again.');
            this.updateLoadingState(false);
            return;
        }

        const selection = editor.selection;
        const text = editor.document.getText(selection);

        if (!text || text.trim().length === 0) {
            this.updateStatus('error', 'No text selected. Please select some text and try again.');
            this.updateLoadingState(false);
            return;
        }

        try {
            this.updateStatus('warning', 'Simulating grantmaker debate...');
            await simulateGrantmakerDebate(
                this._anthropic,
                text,
                this.selectedDebaters,
                async (content: string) => {
                    // Normalize newlines
                    let normalizedContent = content.replace(/\n{3,}/g, '\n\n');
                    const markedContent = await marked(normalizedContent);
                    this.updateFeedback(markedContent);
                },
                () => {
                    if (this._view) {
                        this._view.webview.postMessage({ type: 'scrollToTop' });
                    }
                },
                this.abortController.signal
            );
            this.updateStatus('ok', 'Grantmaker debate completed successfully!');
        } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                this.updateStatus('warning', 'Process was stopped by the user.');
            } else {
                let errorMessage = 'An unknown error occurred';
                if (error instanceof Error) {
                    errorMessage = error.message;
                } else if (typeof error === 'string') {
                    errorMessage = error;
                }
                this.updateStatus('error', `An error occurred: ${errorMessage}`);
            }
        } finally {
            this.updateLoadingState(false);
            this.selectedDebaters = []; // Reset selected debaters
            this.abortController = null;
        }
    }


    private async updateFeedback(feedback: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'updateFeedback', feedback });
        }
    }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const styleResetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "reset.css")
    );
    const styleVSCodeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "vscode.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleResetUri}" rel="stylesheet">
        <link href="${styleVSCodeUri}" rel="stylesheet">
        <title>Grant Application Simulator</title>
        <style>
          body {
            padding: 10px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
          }
          button {
            margin-bottom: 10px;
          }
          #loadingIndicator {
            display: none;
            margin-top: 10px;
            font-weight: bold;
            width: 100%;
          }
          .progress-bar {
            width: 100%;
            height: 20px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-editor-foreground);
            border-radius: 10px;
            overflow: hidden;
          }
          .progress {
            width: 0%;
            height: 100%;
            background-color: var(--vscode-button-background);
            transition: width 0.5s ease;
          }
          #feedbackResult {
            margin-top: 10px;
            white-space: pre-wrap;
            line-height: 1.4;
          }
          #feedbackResult h1, #feedbackResult h2, #feedbackResult h3 {
            margin-top: 1em;
            margin-bottom: 0.5em;
          }
          #feedbackResult p {
            margin-bottom: 0.5em;
          }
          @keyframes flash {
              0% { background-color: transparent; }
              50% { background-color: rgba(255, 255, 0, 0.5); }
              100% { background-color: transparent; }
          }
          .flash {
              animation: flash 1s;
          }
        #stopProcess {
          background-color: #d9534f;
          color: white;
          border: none;
          padding: 5px 10px;
          border-radius: 3px;
          cursor: pointer;
        }
        #stopProcess:hover {
          background-color: #c9302c;
        }
                  #statusIndicator {
          margin-top: 10px;
          padding: 5px;
          border-radius: 3px;
          font-weight: bold;
        }
        .status-ok {
          background-color: #4CAF50;
          color: white;
        }
        .status-warning {
          background-color: #FFC107;
          color: black;
        }
        .status-error {
          background-color: #F44336;
          color: white;
        }
        </style>
      </head>
      <body>
        <h1>Grant Application Simulator</h1>
            <button id="getGrantmakingAdvice">Get Grantmaking Advice</button>
            <button id="getResearchMethodologyAdvice">Get Research Methodology Advice</button>
            <button id="simulateGrantmakerDebate">Simulate Grantmaker Debate</button>
            <button id="stopProcess" style="display: none;">Stop Process</button>
        <div id="statusIndicator" style="display: none;"></div>
        <div id="loadingIndicator">
          <div class="progress-bar">
            <div class="progress"></div>
          </div>
          <span>Loading... <span id="timer">0</span>s</span>
        </div>
        <div id="feedbackResult"></div>
        <script src="${scriptUri}"></script>
      </body>
      </html>`;
  }

  private stopOngoingProcess() {
    if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
    }
}

  public updateLoadingState(isLoading: boolean) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'updateLoadingState', isLoading });
    }
  }
}