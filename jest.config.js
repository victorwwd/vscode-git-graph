module.exports = {
	roots: ['./tests'],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: './tests/tsconfig.json'
		}]
	},
	setupFiles: ['<rootDir>/tests/setup.ts'],
	testRegex: '\\.test\\.ts$',
	moduleFileExtensions: ['ts', 'js'],
	collectCoverageFrom: [
		'src/utils/*.ts',
		'src/*.ts'
	]
};
