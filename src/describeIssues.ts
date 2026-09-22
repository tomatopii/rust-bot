import type { z } from 'zod';

/** zod の検証エラーを「項目: 理由」の行にする（例外メッセージとログ用） */
export function describeIssues(error: z.ZodError): readonly string[] {
    return error.issues.map((issue) => {
        const path = issue.path.map(String).join('.');
        return `${path === '' ? '(root)' : path}: ${issue.message}`;
    });
}
