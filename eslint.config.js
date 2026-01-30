import tseslint from "typescript-eslint"; // Use the wrapper for easier config

export default [
	{
		ignores: ["node_modules/**"],
	},
	// This helper function sets up the parser and plugin automatically
	...tseslint.configs.recommended,
	{
		files: ["**/*.{js,ts}"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			// This is the specific line you were missing:
			parser: tseslint.parser,
		},
		rules: {
			// Your custom rules here
		},
	},
];
