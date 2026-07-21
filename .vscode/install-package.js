const cp = require('child_process');
const fs = require('fs');
const path = require('path');

// Install the most recently built .vsix in the project root. We deliberately do
// NOT derive the filename from `npm_package_version`: that env var is captured by
// npm at `npm run` start time, while `vsce package` reads package.json from disk,
// so the two can disagree (e.g. bumping the version mid-build) and produce an
// ENOENT on the version-stamped filename. Picking the newest name-*.vsix by mtime
// matches exactly what vsce just wrote, regardless of version drift.
const name = process.env.npm_package_name;
const cwd = process.cwd();
let target = null;
try {
	const candidates = fs.readdirSync(cwd)
		.filter((f) => f.endsWith('.vsix') && (!name || f.startsWith(name + '-')))
		.map((f) => ({ f: f, mtime: fs.statSync(path.join(cwd, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	if (candidates.length > 0) target = candidates[0].f;
} catch (_) { /* readdir/stat failed; fall through to the not-found error below */ }

if (!target) {
	console.error('install-package: no .vsix file found in ' + cwd);
	process.exit(1);
}

console.log('Installing ' + target + ' ...');
cp.exec('code --install-extension "' + target + '"', { cwd: cwd }, (err, stdout, stderr) => {
	if (err) {
		console.log('ERROR:');
		console.log(err);
		process.exit(1);
	} else {
		console.log(stderr + stdout);
	}
});
