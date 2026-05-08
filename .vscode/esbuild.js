const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const SRC_DIR = './src';
const OUT_DIR = './out';

async function build() {
	// Ensure output directory exists
	if (!fs.existsSync(OUT_DIR)) {
		fs.mkdirSync(OUT_DIR, { recursive: true });
	}

	// Step 1: Generate type definitions using tsc (required for frontend compilation)
	console.log('Generating type definitions...');
	cp.execSync('tsc -p ./src --emitDeclarationOnly --declaration', { stdio: 'inherit' });

	// Step 2: Build main extension bundle with esbuild
	console.log('Bundling extension with esbuild...');
	await esbuild.build({
		entryPoints: [path.join(SRC_DIR, 'extension.ts')],
		bundle: true,
		outfile: path.join(OUT_DIR, 'extension.js'),
		external: [
			'vscode',
			'original-fs',
			'fs',
			'child_process',
			'crypto',
			'http',
			'https',
			'os',
			'path',
			'stream',
			'zlib',
			'net',
			'readline'
		],
		platform: 'node',
		target: 'node18',
		format: 'cjs',
		sourcemap: true,
		minify: false,
		treeShaking: true
	});

	// Step 3: Build askpass module (separate entry point for Git credential handling)
	await esbuild.build({
		entryPoints: [path.join(SRC_DIR, 'askpass', 'askpassMain.ts')],
		bundle: true,
		outfile: path.join(OUT_DIR, 'askpass', 'askpassMain.js'),
		external: [
			'vscode',
			'original-fs',
			'fs',
			'child_process',
			'crypto',
			'http',
			'https',
			'os',
			'path',
			'stream',
			'zlib',
			'net',
			'readline'
		],
		platform: 'node',
		target: 'node18',
		format: 'cjs',
		sourcemap: true,
		minify: false,
		treeShaking: true
	});

	// Step 4: Copy askpass shell scripts to output directory
	const askpassSrc = path.join(SRC_DIR, 'askpass');
	const askpassOut = path.join(OUT_DIR, 'askpass');

	if (!fs.existsSync(askpassOut)) {
		fs.mkdirSync(askpassOut, { recursive: true });
	}

	fs.readdirSync(askpassSrc).forEach((file) => {
		if (file.endsWith('.sh')) {
			fs.copyFileSync(
				path.join(askpassSrc, file),
				path.join(askpassOut, file)
			);
			console.log(`Copied: ${file}`);
		}
	});

	console.log('esbuild build completed successfully.');
}

build().catch((err) => {
	console.error('esbuild build failed:', err);
	process.exit(1);
});