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
				await context.secrets.store("huggingfaceApiKey", apiKey);
				vscode.window.showInformationMessage("API key saved securely!");
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

// Prompt for API key if not found in secrets
async function getApiKey(context) {
	let apiKey = await context.secrets.get("huggingfaceApiKey");
	if (!apiKey) {
		const choice = await vscode.window.showErrorMessage(
			"Hugging Face API key required!",
			"Enter API Key"
		);
		if (choice === "Enter API Key") {
			apiKey = await vscode.window.showInputBox({
				prompt: "Enter your Hugging Face API key",
				ignoreFocusOut: true
			});
			if (apiKey) {
				await context.secrets.store("huggingfaceApiKey", apiKey);
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

// Request an explanation for the error from Hugging Face API
async function getErrorExplanation(error, errorType, apiKey) {
	try {
		return await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Analyzing error"
		}, async () => {
			try {
				const response = await axios.post(
					"https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-Instruct-v0.1",
					{
						inputs: `Explain this Java ${errorType} error in simple terms: ${error}`,
						parameters: {
							max_new_tokens: 150,
							temperature: 0.7
						}
					},
					{
						headers: {
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json"
						},
						timeout: 30000
					}
				);

				if (!response.data) {
					throw new Error("Empty response from API");
				}

				return processApiResponse(response.data);
			} catch (apiError) {
				console.error("API Request Failed:", apiError);

				if (apiError.response) {
					if (apiError.response.status === 401) {
						return "API Error: Invalid API key. Please check your Hugging Face API key.";
					} else if (apiError.response.status === 429) {
						return "API Error: Rate limit exceeded. Please try again later.";
					} else {
						return `API Error: ${apiError.response.status} - ${apiError.response.statusText}`;
					}
				} else if (apiError.request) {
					return "API Error: No response received. Check your internet connection.";
				} else {
					return `API Error: ${apiError.message}`;
				}
			}
		});
	} catch (progressError) {
		console.error("Progress Error:", progressError);
		return "Error occurred while analyzing the error. Please try again.";
	}
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

// Extract explanation text from API response
function processApiResponse(data) {
	if (!data || !data[0]?.generated_text) return "No explanation available";

	return data[0].generated_text
		.replace(/Explain this Java \w+ error in simple terms:.*?\./s, "")
		.trim()
		.replace(/\n/g, " ");
}

// Show error message with option to view explanation
function showErrorWithExplanation(error, explanation) {
	vscode.window.showErrorMessage(`Java Error: ${error}`, "Show Explanation")
		.then(choice => {
			if (choice === "Show Explanation") {
				vscode.window.showInformationMessage(
					`Error Explanation:\n${explanation}`,
					{ modal: true }
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
