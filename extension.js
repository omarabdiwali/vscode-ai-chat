const vscode = require('vscode');
const openai = require('openai');
const showdown = require('showdown');
const fs = require("node:fs");
const { performance } = require("perf_hooks");

const questionsAndResponses = [];
const userQuestions = [];
const questionHistory = [];
const responseHistory = [];
const duplicatedFiles = new Set();

let originalQuestion = "";
let previousResponse = "";
let currentResponse = "";
let textFromFile = "";

let llmIndex = 0;
let writeToFile = false;
let outputFileName = "output";
let fileTitles = {};
let codeFinished = false;

const converter = new showdown.Converter();
converter.setOption("tables", true);

const llama = "meta-llama/llama-3.3-70b-instruct:free";
const deepseek = "deepseek/deepseek-chat:free";
const gemma = "google/gemini-2.0-flash-lite-preview-02-05:free";
const gemmapro = "google/gemini-2.5-pro-exp-03-25:free";
const gemma3 = "google/gemma-3-27b-it:free";

const llms = [
    gemmapro,
    gemma3,
    gemma,
    llama,
    deepseek
];

const llmNames = [
    "Gemma 2.5 Pro",
    "Gemma 3.0 (27b)",
    "Gemma 2.0 Flash",
    "Llama (70b)",
    "Deepseek V3"
];

const sendToFile = (content, filename) => {
    try {
        const filePath = vscode.workspace.workspaceFolders[0].uri.fsPath + `\\` + filename + ".md";
        fs.writeFileSync(filePath, content, { flag: "a" });
    } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage('Failed to write to file: ' + err.message);
    }
};

const sendStream = (panel, stream) => {
    if (writeToFile) {
        sendToFile(stream, outputFileName);
    } else if (panel && panel.webview) {
        panel.webview.postMessage({ command: "response", text: converter.makeHtml(stream) });
    }
};

const sendChat = async (panel, openChat, chat, index, count, originalQuestion) => {
    const startTime = performance.now();
    currentResponse = "";

    try {
        const stream = await openChat.chat.completions.create({
            model: llms[index],
            stream: true,
            messages: [
                {
                    role: "user",
                    content: chat
                }
            ]
        });

        for await (const chunk of stream) {
            const val = chunk.choices[0]?.delta?.content || "";
            currentResponse += val;
            if (val.length > 0) sendStream(panel, currentResponse);
        }

        if (currentResponse.length === 0) throw new Error("Error: LLM has given no response!");

        const endTime = performance.now();
        let totalTime = `${(endTime - startTime) / 1000}`;
        totalTime = totalTime.substring(0, totalTime.indexOf('.') + 5);
        
        const runTime = `Call to ${llmNames[index]} took ${totalTime} seconds.`;
        const totalResponse = `${currentResponse}\n\n**${runTime}**`;

        if (writeToFile) {
            const pathToFile = vscode.workspace.workspaceFolders[0].uri.fsPath + '\\' + outputFileName;
            const webviewResponse = `The response to your question has been completed at:\n\n **${pathToFile}.md**`;
            sendToFile(`\n\n**${runTime}**\n\n`, outputFileName);

            if (panel && panel.webview) {
                panel.webview.postMessage({ command: "response", text: converter.makeHtml(webviewResponse) });
            }

        } else {
            sendStream(panel, totalResponse);
        }

        questionHistory.push(chat);
        responseHistory.push(totalResponse);
        questionsAndResponses.push({
            question: originalQuestion,
            response: totalResponse
        })

    } catch (err) {
        // console.log(err);
        if (count === llms.length) {
            console.log("hit an error!");
            console.log(err.error);

            if (responseHistory.length < questionHistory.length) {
                responseHistory.push(err.message);
            }

            if (!writeToFile && panel && panel.webview) {
                panel.webview.postMessage({ command: "error", text: err.message, question: chat });
            } else {
                vscode.window.showErrorMessage("Error writing to chat: " + err.message);
            }
        } else {
            index += 1;
            index %= llms.length;
            await sendChat(panel, openChat, chat, index, count + 1, originalQuestion);
        }
    }
};

const replaceFileMentions = (question, files) => {
    for (let file of files) {
        question = question.replace(file, file.substring(1));
    }
    return question;
};

const getLocationFromResponse = (response, locations) => {
    let index = Number(response);
    let location = locations[index];
    location = location.substring(location.indexOf(" ") + 1);
    return location;
};

const addFileToPrompt = async (file, location) => {
    if (duplicatedFiles.has(location)) return "";
    duplicatedFiles.add(location);
    const text = await getTextFromFile(location);
    return file + ":\n" + text;
};

const highlightFilenameMentions = (text) => {
    const regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");
    return text.replace(regEx, (match) => {
        return "<code>" + match + "</code>";
    });
};

const getFileNames = (allFiles) => {
    let fileTitles = {};
    let titleRegEx = new RegExp("\\\\[[\\[\\]a-zA-Z]+\\.[a-zA-Z]+");

    for (const file of allFiles) {
        let path = file.path.substring(1);
        path = path.replaceAll("/", "\\");
        let matchedTitle = path.match(titleRegEx);
        if (!matchedTitle) continue;
        for (let title of matchedTitle) {
            title = title.substring(1);
            if (title in fileTitles) fileTitles[title].push(file.path);
            else fileTitles[title] = [file.path];
        }
    }

    return fileTitles;
};

const getTextFromFile = async (path) => {
    const uri = vscode.Uri.file(path);
    const text = await vscode.workspace.fs.readFile(uri);
    return text;
};

const mentionedFiles = async (matches, titles) => {
    let files = "";
    let response = "";
    let clearance = true;
    let lastFile = null;
    let fulfilled = [];

    if (matches == null) return { response, clearance, match: lastFile, fulfilled, files };

    for (let match of matches) {
        let fileName = match.substring(1);
        if (fileName in titles) {
            if (titles[fileName].length > 1) {
                lastFile = fileName;
                response = `Which ${fileName} are you referring to:\n`;
                clearance = false;
                for (let i = 0; i < titles[fileName].length; i++) {
                    response += `(${i + 1}) ${titles[fileName][i]}\n`;
                }
            } else {
                let loc = titles[fileName][0];
                if (duplicatedFiles.has(loc)) continue;
                const text = await getTextFromFile(loc);

                files += fileName + ":\n" + text + "\n\n";
                fulfilled.push(match);
                duplicatedFiles.add(loc);
            }

            if (!clearance) break;
        }
    }

    return { response, clearance, fulfilled, files, match: lastFile };
};

const getNonce = () => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    let apiKey = context.globalState.get('aiChatApiKey');
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (!apiKey) {
            vscode.window.showErrorMessage('AI Chat requires an OpenRouter API key to function.');
            return;
        }

        await context.globalState.update('aiChatApiKey', apiKey);
    }

    let openChat = new openai.OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: apiKey
    });

    const updateOpenAIClient = (key) => {
        openChat = new openai.OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: key
        });
    };

    const provider = new AIChatViewProvider(context.extensionUri, context);

    const changeApiKeyCommand = vscode.commands.registerCommand('ai-chat.changeApiKey', async () => {
        const newApiKey = await vscode.window.showInputBox({
            prompt: 'Enter your new OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (newApiKey) {
            await context.globalState.update('aiChatApiKey', newApiKey);
            updateOpenAIClient(newApiKey);
            vscode.window.showInformationMessage('OpenRouter API key updated successfully.');
        } else {
            vscode.window.showWarningMessage('No API Key entered. Key not updated.');
        }
    });
    
    const focusChatCommand = vscode.commands.registerCommand('ai-chat.chat.focus', async (data) => {
        if (provider) {
            provider.show();
            provider.handleIncomingData(data);
        } else {
            vscode.window.showWarningMessage("Chat view provider not available yet.");
            await vscode.commands.executeCommand(`${AIChatViewProvider.viewType}.focus`);
        }
    })

    const openChatShortcut = vscode.commands.registerCommand('ai-chat.openChatWithSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        let text = "";

        if (editor) {
            const selection = editor.selection;
            text = editor.document.getText(selection);
        }
        
        await vscode.commands.executeCommand('ai-chat.chat.focus', text);
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AIChatViewProvider.viewType, provider),
        changeApiKeyCommand,
        openChatShortcut
    );

    const include = ''
    const exclude = '{**/node_modules/**,**/.next/**,**/images/**,**/*.png,**/*.jpg,**/*.svg,**/*.git*,**/*.eslint**,**/*.mjs,**/public/**,**/*config**,**/*_**,**/*.lock,**/*.woff}';
    const allFiles = await vscode.workspace.findFiles(include, exclude);
    fileTitles = getFileNames(allFiles);

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.*', false, true, false);
    fileWatcher.onDidCreate(async (uri) => {
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        fileTitles = getFileNames(allFiles);
    });
    fileWatcher.onDidDelete(async (uri) => {
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        fileTitles = getFileNames(allFiles);
    });
}

class AIChatViewProvider {
    static viewType = 'ai-chat.chat';
    _view;

    /**
     * @param {string} _extensionUri
     * @param {vscode.ExtensionContext} context
     */
    constructor(_extensionUri, context) {
        this._extensionUri = _extensionUri;
        this.context = context;
        this.apiKey = context.globalState.get('aiChatApiKey');
        this.regenHtml = 0;
        this.openChat = new openai.OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: this.apiKey
        });
    }

    handleIncomingData(data) {
        let trimmed = data.replaceAll("\n", "").replaceAll(" ", "");
        
        if (trimmed.length > 0) {
            textFromFile = data;
            let htmlText = converter.makeHtml("```\n" + data + "\n```");
            this._view.webview.postMessage({ command: 'content', text: htmlText });
        }

        this._view.webview.postMessage({ command: 'focus' });
    }

    loading() {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage({ command: "loading", text: this._getSpinner() });
        }
    }

    show() {
        if (this._view) {
            this._view.show();
        } else {
            vscode.window.showErrorMessage("Attempted to show view, but it's not resolved yet. Open initially before using the keyboard shortcut.");
        }
    }

    resolveWebviewView(webviewView, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview();
        webviewView.webview.postMessage({ command: 'focus' });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                if (this.regenHtml != questionsAndResponses.length) {
                    webviewView.webview.html = this._getHtmlForWebview();
                    this.regenHtml = questionsAndResponses.length;
                }
                this._view.webview.postMessage({ command: 'focus' });
            } else {
                textFromFile = "";
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command == "chat") {
                let userQuestion = message.text;
                if (!message.context) {
                    userQuestions.push(userQuestion);
                    questionHistory.push(userQuestion);
                }
                writeToFile = message.writeToFile;
                outputFileName = message.outputFile ? message.outputFile : "output";

                if (webviewView && webviewView.webview) {
                    webviewView.webview.postMessage({ command: 'chat', text: userQuestion });
                }
                
                if (!message.context && writeToFile) sendStream(webviewView, "## " + userQuestion + "\n\n");

                let text = message.text;
                let regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");
                let matches = text.match(regEx);

                if (message.context) {
                    let locations = previousResponse.split("\n");
                    let file = getLocationFromResponse(text, locations);
                    const fileValue = await addFileToPrompt(message.file, file);
                    textFromFile += fileValue + "\n";
                    text = replaceFileMentions(questionHistory.at(-1), ["@" + message.file]);
                    questionHistory[questionHistory.length - 1] = text;
                    matches = text.match(regEx);
                }

                let mentioned = await mentionedFiles(matches, fileTitles);
                if (originalQuestion == "") originalQuestion = text;
                text = replaceFileMentions(text, mentioned.fulfilled);
                textFromFile += mentioned.files;

                if (!mentioned.clearance) {
                    previousResponse = mentioned.response;
                    if (webviewView && webviewView.webview) {
                        webviewView.webview.postMessage(
                            {
                                command: "selection",
                                text: mentioned.response,
                                file: mentioned.match,
                                maxVal: fileTitles[mentioned.match].length
                            }
                        );
                    }
                    return;
                }

                let question = `${text}\n\n${textFromFile}`;
                this.loading();
                
                webviewView.webview.postMessage( {command: 'content', text: '' });
                await sendChat(webviewView, this.openChat, question, llmIndex, 0, originalQuestion);

                textFromFile = "";
                originalQuestion = "";
                duplicatedFiles.clear();

            } else if (message.command === 'copy') {
                vscode.env.clipboard.writeText(message.text);
            } else if (message.command == "selectLLM") {
                llmIndex = parseInt(message.index);
            } else if (message.command === 'remove') {
                textFromFile = "";
            }
        });
    }

    _getSpinner() {
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "spinner.css"));
        return /*html*/`
        <link rel="stylesheet" href="${cssFile}">
        <div id="container"><div id="spinner"></div></div>
        `;
    }

    _getHtmlForWebview() {
        let optionsHtml = '';
        for (let i = 0; i < llmNames.length; i++) {
            optionsHtml += `<option value="${i}" ${i === llmIndex ? 'selected' : ''}>${llmNames[i]}</option>`;
        }

        let chatHistoryHtml = '';
        for (let i = 0; i < questionsAndResponses.length; i++) {
              chatHistoryHtml += `
                <div class="chat-entry">
                    <div class="question"><strong>You:</strong> ${highlightFilenameMentions(questionsAndResponses[i].question)}</div>
                    <div class="response">${converter.makeHtml(questionsAndResponses[i].response)}</div>
                </div>
            `;
        }

        const jsFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview.js"));
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "styles.css"));
        const nonce = getNonce();

        return /*html*/`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css">
            <link rel="stylesheet" href="${cssFile}">
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
            <title>AI Chat</title>
          </head>
          <body>
            <div id="chat-container">
                <div id="input-area">
                    <textarea id="prompt" rows="3" placeholder="Type your message here..."></textarea>
                    <div id="llmDropdown">
                        <label for="llmSelect">Select LLM:</label>
                        <select id="llmSelect">
                            ${optionsHtml}
                        </select>
                    </div>

                    <div class="checkbox-button-container">
                        <input type="checkbox" id="writeToFileCheckbox" class="checkbox-button-input" ${writeToFile ? 'checked' : ''}>
                        <label for="writeToFileCheckbox" class="checkbox-button-label">Write to File</label>
                        <input ${writeToFile ? "" : "disabled"} type="text" id="outputFileNameInput" value="${outputFileName == "output" ? "" : outputFileName}" placeholder="Enter file name...">
                    </div>
                    
                    <div id="content"></div>
                    <button id="ask">Ask</button>
                </div>
                <div id="chat-history">
                    ${chatHistoryHtml}
                </div>
            </div>
            <script nonce="${nonce}" src="${jsFile}"></script>
          </body>
        </html>
        `;
    }
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
}