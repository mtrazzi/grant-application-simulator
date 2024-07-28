(function () {
    const vscode = acquireVsCodeApi();

    const grantmakingButton = document.getElementById('getGrantmakingAdvice');
    const researchButton = document.getElementById('getResearchMethodologyAdvice');
    const debateButton = document.getElementById('simulateGrantmakerDebate');
    const stopButton = document.getElementById('stopProcess');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const feedbackResult = document.getElementById('feedbackResult');
    const progressBar = document.querySelector('.progress');
    const timerSpan = document.getElementById('timer');
    const statusIndicator = document.getElementById('statusIndicator');

    let loadingTimer;
    let selectedDebaters = [];

    grantmakingButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'getGrantmakingAdvice' });
    });

    researchButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'getResearchMethodologyAdvice' });
    });

    debateButton.addEventListener('click', () => {
        selectedDebaters = [];
        vscode.postMessage({ type: 'startDebaterSelection' });
    });

    stopButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'stopProcess' });
    });

    function scrollToTop() {
        window.scrollTo(0, 0);
    }

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'updateFeedback':
                feedbackResult.innerHTML = message.feedback;
                feedbackResult.scrollTop = feedbackResult.scrollHeight; // Auto-scroll to bottom
                break;
            case 'updateLoadingState':
                updateLoadingState(message.isLoading);
                break;
            case 'updateStatus':
                updateStatus(message.status, message.message);
                break;
            case 'scrollToTop':
                scrollToTop();
                const summaryElement = document.querySelector('#summary');
                if (summaryElement) {
                    summaryElement.classList.add('flash');
                    setTimeout(() => summaryElement.classList.remove('flash'), 1000);
                }
                break;
            case 'debaterSelected':
                selectedDebaters.push(message.debater);
                feedbackResult.innerHTML = `Selected: ${message.debater}. ${selectedDebaters.length === 1 ? 'Please select the second debater.' : 'Starting debate...'}`;
                if (selectedDebaters.length === 2) {
                    vscode.postMessage({ type: 'simulateGrantmakerDebate', debaters: selectedDebaters });
                }
                break;
        }
    });

    function updateLoadingState(isLoading) {
        if (isLoading) {
            loadingIndicator.style.display = 'block';
            feedbackResult.innerHTML = '';
            stopButton.style.display = 'inline-block';
            grantmakingButton.disabled = true;
            researchButton.disabled = true;
            debateButton.disabled = true;
            let seconds = 0;
            loadingTimer = setInterval(() => {
                seconds++;
                timerSpan.textContent = seconds;
                progressBar.style.width = `${(seconds % 10) * 10}%`;
            }, 1000);
        } else {
            loadingIndicator.style.display = 'none';
            stopButton.style.display = 'none';
            grantmakingButton.disabled = false;
            researchButton.disabled = false;
            debateButton.disabled = false;
            clearInterval(loadingTimer);
            progressBar.style.width = '0%';
        }
    }
    function updateStatus(status, message) {
        statusIndicator.style.display = 'block';
        statusIndicator.textContent = message;
        statusIndicator.className = `status-${status}`;

        // Auto-hide success messages after 5 seconds
        if (status === 'ok') {
            setTimeout(() => {
                statusIndicator.style.display = 'none';
            }, 5000);
        }
    }
})();