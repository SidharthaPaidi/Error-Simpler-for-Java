const vscode = require("vscode");
const { exec } = require("child_process");
const { promisify } = require("util");
const axios = require("axios");
const path = require("path");

const execAsync = promisify(exec);

async function activate(context) {
	console.log("Error Simplifier Extension Activated!");

	// Check for Java installation
	await verifyJavaInstallation();

	// Register commands
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

	// Auto-detect Java file saves
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

async function executeJavaWithErrors(filePath, apiKey) {
	const { dir: fileDir, name: className } = path.parse(filePath);

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Processing Java file"
	}, async (progress) => {
		progress.report({ message: "Compiling..." });
		const compileOutput = await compileJava(filePath);

		progress.report({ message: "Running..." });
		const runtimeOutput = await runJava(fileDir, className);

		vscode.window.showInformationMessage(`Program Output:\n${runtimeOutput}`);
	});
}

async function compileJava(filePath) {
	try {
		const { stderr } = await execAsync(`javac "${filePath}"`);
		return stderr;
	} catch (error) {
		await handleCompilationError(error.stderr, filePath);
		throw error;
	}
}

async function runJava(fileDir, className) {
	try {
		const { stdout, stderr } = await execAsync(`java -cp "${fileDir}" ${className}`);
		if (stderr) throw new Error(stderr);
		return stdout;
	} catch (error) {
		await handleRuntimeError(error.message, fileDir);
		throw error;
	}
}

async function handleCompilationError(errorOutput, filePath) {
	const cleanError = cleanJavaError(errorOutput, filePath);
	const explanation = await getErrorExplanation(cleanError, "compilation");
	showErrorWithExplanation(cleanError, explanation);
}

async function handleRuntimeError(errorOutput, fileDir) {
	const cleanError = cleanJavaError(errorOutput, fileDir);
	const explanation = await getErrorExplanation(cleanError, "runtime");
	showErrorWithExplanation(cleanError, explanation);
}

function cleanJavaError(error, contextPath) {
	return error.replace(new RegExp(contextPath, "g"), "")
		.split("\n")
		.filter(line => !line.includes("Note:"))
		.join("\n")
		.trim();
}

// Update the getErrorExplanation function signature
async function getErrorExplanation(error, errorType, apiKey) {  // Add apiKey parameter
	try {
		return await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Analyzing error"
		}, async () => {
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
						Authorization: `Bearer ${apiKey}`,  // Use passed apiKey
						"Content-Type": "application/json"
					},
					timeout: 30000
				}
			);

			return processApiResponse(response.data);
		});
	} catch (error) {
		console.error("API Error:", error);
		return "Could not get explanation. Please check your API key and connection.";
	}
}

// Update the calls to getErrorExplanation in both handler functions
async function handleCompilationError(errorOutput, filePath, apiKey) {  // Add apiKey parameter
	const cleanError = cleanJavaError(errorOutput, filePath);
	const explanation = await getErrorExplanation(cleanError, "compilation", apiKey);
	showErrorWithExplanation(cleanError, explanation);
}

async function handleRuntimeError(errorOutput, fileDir, apiKey) {  // Add apiKey parameter
	const cleanError = cleanJavaError(errorOutput, fileDir);
	const explanation = await getErrorExplanation(cleanError, "runtime", apiKey);
	showErrorWithExplanation(cleanError, explanation);
}

// Update the error handler calls in compileJava and runJava functions
async function compileJava(filePath, apiKey) {  // Add apiKey parameter
	try {
		const { stderr } = await execAsync(`javac "${filePath}"`);
		return stderr;
	} catch (error) {
		await handleCompilationError(error.stderr, filePath, apiKey);  // Pass apiKey
		throw error;
	}
}

async function runJava(fileDir, className, apiKey) {  // Add apiKey parameter
	try {
		const { stdout, stderr } = await execAsync(`java -cp "${fileDir}" ${className}`);
		if (stderr) throw new Error(stderr);
		return stdout;
	} catch (error) {
		await handleRuntimeError(error.message, fileDir, apiKey);  // Pass apiKey
		throw error;
	}
}

// Update the executeJavaWithErrors function
async function executeJavaWithErrors(filePath, apiKey) {
	const { dir: fileDir, name: className } = path.parse(filePath);

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Processing Java file"
	}, async (progress) => {
		progress.report({ message: "Compiling..." });
		const compileOutput = await compileJava(filePath, apiKey);  // Pass apiKey

		progress.report({ message: "Running..." });
		const runtimeOutput = await runJava(fileDir, className, apiKey);  // Pass apiKey

		vscode.window.showInformationMessage(`Program Output:\n${runtimeOutput}`);
	});
}

function processApiResponse(data) {
	if (!data || !data[0]?.generated_text) return "No explanation available";

	return data[0].generated_text
		.replace(/Explain this Java \w+ error in simple terms:.*?\./s, "")
		.trim()
		.replace(/\n/g, " ");
}

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