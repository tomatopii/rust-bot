import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // ログは consola に統一する（起動時のエラー表示も含む）
            'no-console': 'error',
        },
    },
);
