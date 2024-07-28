import * as vscode from 'vscode';
import Anthropic from "@anthropic-ai/sdk";

import * as fs from 'fs';
import * as path from 'path';

import { SidebarProvider } from './SidebarProvider';

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

interface AnthropicError extends Error {
    status?: number;
    error?: {
        type: string;
        message: string;
    };
}

function logPrompt(researcher: string, systemPrompt: string, userPrompt: string) {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir);
    }

    const logFile = path.join(logDir, 'claude_prompts.log');
    const timestamp = new Date().toISOString();
    const logEntry = `
${timestamp}
Researcher: ${researcher}
System Prompt:
${systemPrompt}

User Prompt:
${userPrompt}

----------------------------------------
`;

    fs.appendFileSync(logFile, logEntry);
}

async function retryableAnthropicRequest(requestFn: () => Promise<any>, timeout = 30000): Promise<any> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Request timed out')), timeout)
            );
            const result = await Promise.race([requestFn(), timeoutPromise]);
            return result;
        } catch (error) {
            const anthropicError = error as AnthropicError;
            console.error(`Attempt ${attempt} failed:`, anthropicError);

            if (attempt === MAX_RETRIES) {
                throw new Error(`Failed after ${MAX_RETRIES} attempts: ${anthropicError.message}`);
            }

            if (anthropicError.status === 500 || anthropicError.message.includes('timed out')) {
                console.log(`Retrying in ${RETRY_DELAY}ms...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                throw error;
            }
        }
    }
}

export async function getResearcherResponse(anthropic: Anthropic, researcher: string, text: string, systemPrompt: string, signal: AbortSignal): Promise<string> {
    const [firstName, lastName] = researcher.toLowerCase().split(' ');
    const promptFilePath = path.join(__dirname, '..', 'src', 'prompts', `${firstName}_${lastName}.txt`);
    let researcherPrompt = '';
    try {
        researcherPrompt = fs.readFileSync(promptFilePath, 'utf8');
    } catch (error) {
        console.warn(`Failed to read prompt file for ${researcher}. Using default prompt.`);
    }

    const finalSystemPrompt = `${systemPrompt}\n\nYou are ${researcher}. Provide a response that reflects your unique viewpoints and critiques. Focus on your specific background and expertise. Avoid general ethical considerations or points that other researchers could make. Be concise and direct. What specific, unique critique or insight would you give to this code or text snippet, as a way to make progress in AI Alignment? Do not mention your name in your answer, or speak in the third person. Really speak like if you were that person. Here is some text that represents your unique perspective: [BEGIN TEXT]${researcherPrompt}[END TEXT]. Speak like you were that person. \n\n Again, DO NOT USE ANY BULLET POINTS AND ONLY SAY ONE PARAGRAPH`;

    logPrompt(researcher, finalSystemPrompt, text);

    return await retryableAnthropicRequest(async () => {
        if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 200,
            temperature: 0.7,
            system: finalSystemPrompt,
            messages: [
                {
                    role: "user",
                    content: text
                }
            ],
        });

        if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        return msg.content.reduce((acc, block) => {
            if ('text' in block) {
                return acc + block.text;
            }
            return acc;
        }, '');
    });
}

export async function synthesizeDiscussion(anthropic: Anthropic, responses: string[], researcherNames: string[], title: string): Promise<string> {
    const systemPrompt = `You're summarizing a discussion between AI alignment researchers about ${title}. Be concise and formal. Your summary should be a list of ${researcherNames.length} bullet points. Each bullet point should:
    - Start with the researcher's full name
    - Be 1-2 sentences long, using proper grammar
    - Summarize the researcher's main argument or perspective
    - Not use a colon after the researcher's name
    Example: "• Paul believes that the core challenge in alignment progress is generating novel ideas, not facilitating easier communication of existing ones."

    Ensure you use the correct researcher names: ${researcherNames.join(', ')}. Avoid colloquial language or phrases like "Here's a summary".`;

    const userPrompt = `Here's what different researchers said:\n\n${responses.map((response, index) => `${researcherNames[index]}:\n${response}`).join('\n\n')}\n\nProvide a summary of this discussion as specified.`;

    logPrompt('Synthesis', systemPrompt, userPrompt);

    return await retryableAnthropicRequest(async () => {
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 500,
            temperature: 0.3,
            system: systemPrompt,
            messages: [
                {
                    role: "user",
                    content: userPrompt
                }
            ]
        });

        let summary = msg.content.reduce((acc, block) => {
            if ('text' in block) {
                return acc + block.text;
            }
            return acc;
        }, '');

        // Ensure correct formatting
        summary = summary.replace(/^Key points:/m, '## Key points:\n');
        summary = summary.replace(/^([^•\n])/gm, '\n$1');  // Ensure paragraphs start on new lines
        summary = summary.replace(/\n{3,}/g, '\n\n');  // Remove excess newlines

        const formattedResponses = responses.map((response, index) => {
            const researcher = researcherNames[index];
            return `### ${researcher}\n\n${response}\n\n`;
        }).join('');

        return `# Summary\n\n${summary.trim()}\n\n## Full Responses\n\n${formattedResponses}`;
    });
}

export function shuffle<T>(array: T[]): T[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

export async function simulateGrantmakerDebate(
    anthropic: Anthropic,
    text: string,
    selectedDebaters: string[],
    updateCallback: (content: string) => void,
    scrollToTopCallback: () => void,
    signal: AbortSignal
): Promise<string> {
    const grantmakers = selectedDebaters;
    const messageCount = 3;
    let debate = `# Grantmaker Debate: Funding Decision\n\n`;
    let debateHistory = '';
    updateCallback(debate);

    for (let i = 0; i < messageCount * 2; i++) {
        if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const grantmaker = grantmakers[i % 2];
        const isFirstMessage = i === 0;

        const systemPrompt = `You are ${grantmaker}, a grantmaker in AI alignment. You're discussing with your colleague whether to fund the following grant proposal. ${isFirstMessage ? "Provide your initial thoughts on the proposal." : "Respond to your colleague's points, then add your own perspective. Ensure you're addressing the most recent points made by your colleague."} Consider the proposal's potential impact, feasibility, and alignment with current priorities in the field. Be concise, direct, and focus on your unique expertise and viewpoint. Avoid general statements that any grantmaker could make.`;

        const stream = await anthropic.messages.stream({
            max_tokens: 250,
            temperature: 0.7,
            system: systemPrompt,
            messages: [
                { role: 'user', content: `${text}\n\nDebate history:\n${debateHistory}` }
            ],
            model: 'claude-3-opus-20240229',
        });

        let fullResponse = '';
        for await (const chunk of stream) {
            if (signal.aborted) {
                stream.controller.abort();
                throw new DOMException('Aborted', 'AbortError');
            }
            if (chunk.type === 'content_block_delta' && 'text' in chunk.delta) {
                fullResponse += chunk.delta.text;
                updateCallback(`${debate}### ${grantmaker}\n\n${fullResponse}\n\n`);
            }
        }

        debate += `### ${grantmaker}\n\n${fullResponse}\n\n`;
        debateHistory += `${grantmaker}: ${fullResponse}\n\n`;
        updateCallback(debate);
    }

    scrollToTopCallback();
    updateCallback(debate + "\n\nGenerating summary...");

    // Generate summary
    if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    const summarySystemPrompt = `You are an AI assistant summarizing a debate between two grantmakers about an AI alignment research proposal. Provide a concise summary of the key points discussed, including areas of agreement and disagreement, main concerns, and potential strengths of the proposal. Do not make a funding recommendation.`;

    const summaryStream = await anthropic.messages.stream({
        max_tokens: 300,
        temperature: 0.3,
        system: summarySystemPrompt,
        messages: [
            { role: 'user', content: debate }
        ],
        model: 'claude-3-opus-20240229',
    });

    let fullSummary = '';
    for await (const chunk of summaryStream) {
        if (signal.aborted) {
            summaryStream.controller.abort();
            throw new DOMException('Aborted', 'AbortError');
        }
        if (chunk.type === 'content_block_delta' && 'text' in chunk.delta) {
            fullSummary += chunk.delta.text;
            updateCallback(`# Grantmaker Debate: Funding Decision\n\n## Order of Speakers\n\n1. ${grantmakers[0]}\n2. ${grantmakers[1]}\n\n## Summary\n\n${fullSummary}\n\n## Full Debate\n\n${debate}`);
        }
    }

    const finalDebate = `# Grantmaker Debate: Funding Decision\n\n## Order of Speakers\n\n1. ${grantmakers[0]}\n2. ${grantmakers[1]}\n\n## Summary\n\n${fullSummary}\n\n## Full Debate\n\n${debate}`;
    updateCallback(finalDebate);

    return finalDebate;
}

function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    return new Promise((resolve) => {
        let apiKey = vscode.workspace.getConfiguration().get('grantApplicationSimulator.anthropicApiKey') as string;

        if (!apiKey || apiKey.trim() === '') {
            vscode.window.showInputBox({
                prompt: 'Please enter your Anthropic API Key',
                password: true
            }).then(inputApiKey => {
                if (inputApiKey && inputApiKey.trim() !== '') {
                    vscode.workspace.getConfiguration().update('grantApplicationSimulator.anthropicApiKey', inputApiKey, true);
                    resolve(inputApiKey);
                } else {
                    vscode.window.showErrorMessage('Anthropic API Key is required to use this extension.');
                    resolve(undefined);
                }
            });
        } else {
            resolve(apiKey);
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "grant-application-simulator" is now active!');

    let apiKey = vscode.workspace.getConfiguration().get('grantApplicationSimulator.anthropicApiKey') as string;

    let resetApiKeyCommand = vscode.commands.registerCommand('grant-application-simulator.resetApiKey', () => {
        vscode.workspace.getConfiguration().update('grantApplicationSimulator.anthropicApiKey', undefined, true).then(() => {
            vscode.window.showInformationMessage('API Key has been reset. The extension will prompt for a new key on next use.');
        });
    });

    context.subscriptions.push(resetApiKeyCommand);

    getApiKey(context).then(apiKey => {
        if (apiKey) {
            initializeExtension(context, apiKey);
        }
    });
}

function initializeExtension(context: vscode.ExtensionContext, apiKey: string) {
    const sidebarProvider = new SidebarProvider(context.extensionUri, apiKey);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "grant-application-simulator-view",
            sidebarProvider
        )
    );

    let disposable = vscode.commands.registerCommand('grant-application-simulator.showFeedbackView', () => {
        vscode.commands.executeCommand('workbench.view.extension.grant-application-simulator');
    });

    context.subscriptions.push(disposable);

    vscode.commands.executeCommand('workbench.view.extension.grant-application-simulator');
}

export function deactivate() {}