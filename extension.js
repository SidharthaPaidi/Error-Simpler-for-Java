const vscode = require("vscode");
const { exec } = require("child_process");
const { promisify } = require("util");
const axios = require("axios");
const path = require("path");

const execAsync = promisify(exec);

async function activate(context) {
	console.log("Error Simplifier Extension Activated!");

	// Ensure Java is installed before proceeding
	await verifyJavaInstallation();

	// Register extension commands
	context.subscriptions.push(
		vscode.commands.registerCommand("errorsimplifier.runJavaFile", () => handleJavaExecution(context)),
		vscode.commands.registerCommand("errorsimplifier.setApiKey", async () => {
			const apiKey = await vscode.window.showInputBox({
				prompt: "Enter your Hugging Face API key",
				ignoreFocusOut: true
			});
			if (apiKey) {
				if (!validateApiKey(apiKey)) {
					vscode.window.showErrorMessage("Invalid API key format. Together.ai keys start with 'tg_api_'");
					return;
				}

				
				await context.secrets.store("togetherApiKey", apiKey);
				vscode.window.showInformationMessage("API key saved securely!");
			}
		}),
		vscode.commands.registerCommand("errorsimplifier.setModel", async () => {
			const model = await vscode.window.showQuickPick([
				"mistralai/Mixtral-8x7B-Instruct-v0.1",
				"mistralai/Mistral-7B-Instruct-v0.1",
				"codellama/CodeLlama-7b-Instruct-hf",
				"deepseek-ai/deepseek-coder-6.7b-instruct"
			], {
				placeHolder: "Select AI model for error explanations",
				ignoreFocusOut: true
			});

			if (model) {
				await context.workspaceState.update("selectedModel", model);
				vscode.window.showInformationMessage(`Model set to: ${model}`);
			}
		})

	);

	// Automatically run on Java file save
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (document) => {
			if (document.languageId === "java") {
				await handleJavaExecution(context, document.fileName);
			}
		})
	);
}

async function handleJavaExecution(context, filePath) {
	const editor = vscode.window.activeTextEditor;
	filePath = filePath || editor?.document.fileName;

	if (!filePath || !filePath.endsWith(".java")) {
		vscode.window.showErrorMessage("Please open a Java file first");
		return;
	}

	try {
		const apiKey = await getApiKey(context);
		await executeJavaWithErrors(filePath, apiKey);
	} catch (error) {
		vscode.window.showErrorMessage(error.message);
	}
}

// Validate API key format
function validateApiKey(apiKey) {
	return apiKey.startsWith("tg_api_");
}

// Prompt for API key if not found in secrets
async function getApiKey(context) {
	let apiKey = await context.secrets.get("togetherApiKey");
	if (!apiKey) {
		const choice = await vscode.window.showErrorMessage(
			"Together.ai API key required!",
			"Enter API Key"
		);
		if (choice === "Enter API Key") {
			apiKey = await vscode.window.showInputBox({
				prompt: "Enter your Together.ai API key",
				ignoreFocusOut: true
			});
			if (apiKey) {
				await context.secrets.store("togetherApiKey", apiKey);
				return apiKey;
			}
		}
		throw new Error("API key is required to use this extension");
	}
	return apiKey;
}

// Remove file paths and unnecessary lines from error output
function cleanJavaError(error, contextPath) {
	return error.replace(new RegExp(contextPath, "g"), "")
		.split("\n")
		.filter(line => !line.includes("Note:"))
		.join("\n")
		.trim();
}

async function getErrorExplanation(errorType, errorText, apiKey) {
	const config = vscode.workspace.getConfiguration('errorSimplifier');
	const model = config.get('model') || "mistralai/Mixtral-8x7B-Instruct-v0.1";

	const prompt = `Explain this Java ${errorType} error in simple terms: ${errorText}`;

	const maxTokens = config.get('maxTokens') || 200;
	const temperature = config.get('temperature') || 0.7;

	return await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Analyzing error",
		cancellable: false
	}, async () => {
		let retries = 3;

		while (retries > 0) {
			try {
				const response = await axios.post(
					"https://api.together.xyz/v1/chat/completions",
					{
						model,
						messages: [
							{
								role: "system",
								content: "You are a helpful programming assistant. Explain errors in simple terms with 1-2 sentence solutions."
							},
							{ role: "user", content: prompt }
						],
						max_tokens: maxTokens,
						temperature
					},
					{
						headers: {
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json"
						},
						timeout: 30000
					}
				);

				return formatExplanation(response.data.choices[0].message.content);
			} catch (err) {
				if (err.response?.status === 429 && retries > 0) {
					// Exponential backoff for rate limits
					const delay = Math.pow(2, 4 - retries) * 1000;
					await new Promise(resolve => setTimeout(resolve, delay));
					retries--;
					continue;
				}

				console.error("API Error:", err.response?.data || err.message);

				if (err.response) {
					if (err.response.status === 401) {
						throw new Error("Invalid API key. Please check your Together.ai API key.");
					} else if (err.response.status === 404) {
						throw new Error(`Model ${model} not found. Check your model name.`);
					} else {
						throw new Error(`API Error: ${err.response.status} - ${err.response.statusText}`);
					}
				} else if (err.request) {
					throw new Error("No response from API. Check your internet connection.");
				} else {
					throw new Error(`API Request Error: ${err.message}`);
				}
			}
		}
		throw new Error("API request failed after multiple retries");
	});
}


// Format the explanation for better readability
function formatExplanation(rawText) {
	return rawText
		.replace(/\n\s*\n/g, "\n\n") // Clean up extra newlines
		.replace(/(\d+\.)\s*/g, "\n$1 ") // Format numbered lists
		.replace(/\*\*(.*?)\*\*/g, (_, match) => `**${match.trim()}**`); // Markdown bold
}

// Handle compilation errors and show explanations
async function handleCompilationError(errorOutput, filePath, apiKey) {
	const cleanError = cleanJavaError(errorOutput, filePath);
	const explanation = await getErrorExplanation(cleanError, "compilation", apiKey);
	showErrorWithExplanation(cleanError, explanation);
}

// Handle runtime errors and show explanations
async function handleRuntimeError(errorOutput, fileDir, apiKey) {
	const cleanError = cleanJavaError(errorOutput, fileDir);
	const explanation = await getErrorExplanation(cleanError, "runtime", apiKey);
	showErrorWithExplanation(cleanError, explanation);
}

// Compile Java file and handle errors
async function compileJava(filePath, apiKey) {
	try {
		const { stderr } = await execAsync(`javac "${filePath}"`);
		return stderr;
	} catch (error) {
		await handleCompilationError(error.stderr, filePath, apiKey);
		throw error;
	}
}

// Run Java class and handle errors
async function runJava(fileDir, className, apiKey) {
	try {
		const { stdout, stderr } = await execAsync(`java -cp "${fileDir}" ${className}`);
		if (stderr) throw new Error(stderr);
		return stdout;
	} catch (error) {
		await handleRuntimeError(error.message, fileDir, apiKey);
		throw error;
	}
}

// Compile and run Java file, showing output or errors
async function executeJavaWithErrors(filePath, apiKey) {
	const { dir: fileDir, name: className } = path.parse(filePath);

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Processing Java file"
	}, async (progress) => {
		progress.report({ message: "Compiling..." });
		const compileOutput = await compileJava(filePath, apiKey);

		progress.report({ message: "Running..." });
		const runtimeOutput = await runJava(fileDir, className, apiKey);

		vscode.window.showInformationMessage(`Program Output:\n${runtimeOutput}`);
	});
}

// Show program output in a dedicated panel
function showOutputInPanel(output) {
	const panel = vscode.window.createOutputChannel("Java Program Output");
	panel.clear();
	panel.appendLine("=== Program Execution Result ===");
	panel.append(output);
	panel.show();
}

// Show error message with option to view explanation
function showErrorWithExplanation(error, explanation) {
	const truncatedError = error.length > 200 ? error.substring(0, 200) + "..." : error;

	vscode.window.showErrorMessage(`Java Error: ${truncatedError}`, "Show Explanation")
		.then(choice => {
			if (choice === "Show Explanation") {
				vscode.window.showInformationMessage(
					`Error Explanation:\n\n${explanation}`,
					{ modal: true, detail: "Detailed explanation from AI assistant" }
				);
			}

		});
}

// Check if Java is installed, prompt user if not
async function verifyJavaInstallation() {
	try {
		await execAsync("javac -version");
	} catch (error) {
		vscode.window.showErrorMessage(
			"Java JDK not found! Please install Java Development Kit to use this extension.",
			"Open Download Page"
		).then(choice => {
			if (choice === "Open Download Page") {
				vscode.env.openExternal(vscode.Uri.parse("https://adoptium.net/"));
			}
		});
	}
}

function deactivate() { }

module.exports = {
	activate,
	deactivate
};
