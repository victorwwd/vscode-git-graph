const fs = require('fs');
const path = require('path');

const OUT_DIRECTORY = './out';

// Files that need fs fallback processing (esbuild bundles into these entry points)
const FILES_TO_PROCESS = [
	path.join(OUT_DIRECTORY, 'extension.js'),
	path.join(OUT_DIRECTORY, 'askpass', 'askpassMain.js')
];

/**
 * Adjust scripts that require the Node.js File System Module to use the Node.js version
 * (as Electron overrides the fs module with its own version of the module)
 */
FILES_TO_PROCESS.forEach((scriptFilePath) => {
	if (!fs.existsSync(scriptFilePath)) {
		console.log(`File not found: ${scriptFilePath}, skipping.`);
		return;
	}

	let script = fs.readFileSync(scriptFilePath).toString();

	// Check if the script uses fs module
	if (script.match(/require\("fs"\)/g)) {
		console.log(`Processing fs fallback for: ${scriptFilePath}`);

		// Insert the fallback function after "use strict"
		script = script.replace(
			/"use strict";/,
			'"use strict";\nfunction requireWithFallback(electronModule, nodeModule) { try { return require(electronModule); } catch (err) {} return require(nodeModule); }'
		);

		// Replace all require("fs") with requireWithFallback("original-fs", "fs")
		script = script.replace(/require\("fs"\)/g, 'requireWithFallback("original-fs", "fs")');

		fs.writeFileSync(scriptFilePath, script);

		// Adjust the source map file, as we added requireWithFallback on a new line at the start of the file
		const mapFilePath = scriptFilePath + '.map';
		if (fs.existsSync(mapFilePath)) {
			let data = JSON.parse(fs.readFileSync(mapFilePath).toString());
			data.mappings = ';' + data.mappings;
			fs.writeFileSync(mapFilePath, JSON.stringify(data));
		}
	}
});

console.log('fs fallback processing completed.');
