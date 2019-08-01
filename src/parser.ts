import * as semver from 'semver';
import * as vscode from 'vscode';
import { BEST_TOOL_VERSION } from './utils/tool-check';


interface ShellCheckReplacement {
    precedence: number;
    line: number;
    endLine: number;
    column: number;
    endColumn: number;
    insertionPoint: string;
    replacement: string;
}

interface ShellCheckItem {
    file: string;
    line: number;
    endLine?: number;
    column: number;
    endColumn?: number;
    level: string;
    code: number;
    message: string;
    fix?: {
        replacements: ShellCheckReplacement[];
    };
}

export interface Parser {
    readonly outputFormat: string;
    readonly textDocument: vscode.TextDocument;

    parse(s: string): ParseResult[];
}

export interface ParseResult {
    diagnostic: vscode.Diagnostic;
    codeAction: vscode.CodeAction | null;
}

class JsonParserMixin {
    protected doParse(textDocument: vscode.TextDocument, items: ShellCheckItem[]): ParseResult[] {
        const result: ParseResult[] = [];
        for (const item of items) {
            if (!item) {
                continue;
            }

            const diagnostic = this.makeDiagnostic(item);
            const codeAction = this.makeCodeAction(item, textDocument, diagnostic);
            result.push({
                diagnostic,
                codeAction
            });
        }

        return result;
    }

    protected makeCodeAction(item: ShellCheckItem, textDocument: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | null {
        if (!item.fix || item.fix.replacements.length === 0) {
            return null;
        }

        const edits = this.createTextEdits(item.fix.replacements);
        if (!edits.length) {
            return null;
        }

        const fix = new vscode.CodeAction(`Apply fix for SC${item.code}`, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [diagnostic];
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.set(textDocument.uri, edits);
        return fix;
    }

    private createTextEdits(replacements: ShellCheckReplacement[]): vscode.TextEdit[] {
        if (replacements.length === 1) {
            return [this.createTextEdit(replacements[0])];
        } else if (replacements.length === 2) {
            return [this.createTextEdit(replacements[1]), this.createTextEdit(replacements[0])];
        }

        return [];
    }

    private createTextEdit(repl: ShellCheckReplacement): vscode.TextEdit {
        const startPos = this.fixPosition(new vscode.Position(repl.line - 1, repl.column - 1));
        const endPos = this.fixPosition(new vscode.Position(repl.endLine - 1, repl.endColumn - 1));
        return new vscode.TextEdit(new vscode.Range(startPos, endPos), repl.replacement);
    }

    protected makeDiagnostic(item: ShellCheckItem): vscode.Diagnostic {
        let startPos = new vscode.Position(item.line - 1, item.column - 1);
        const endLine = item.endLine ? item.endLine - 1 : startPos.line;
        const endCharacter = item.endColumn ? item.endColumn - 1 : startPos.character;
        let endPos = new vscode.Position(endLine, endCharacter);
        if (startPos.isEqual(endPos)) {
            startPos = this.fixPosition(startPos);
            endPos = startPos;
        } else {
            startPos = this.fixPosition(startPos);
            endPos = this.fixPosition(endPos);
        }

        const range = new vscode.Range(startPos, endPos);
        const severity = levelToDiagnosticSeverity(item.level);
        const diagnostic = new vscode.Diagnostic(range, item.message, severity);
        diagnostic.source = 'shellcheck';
        diagnostic.code = `SC${item.code}`;
        diagnostic.tags = scCodeToDiagnosticTags(item.code);
        return diagnostic;
    }

    protected fixPosition(pos: vscode.Position): vscode.Position {
        return pos;
    }
}

// Compatibility parser
class JsonParser extends JsonParserMixin implements Parser {
    public readonly outputFormat = 'json';

    constructor(public readonly textDocument: vscode.TextDocument) {
        super();
    }

    public parse(s: string): ParseResult[] {
        const items = <ShellCheckItem[]>JSON.parse(s);
        return this.doParse(this.textDocument, items);
    }

    protected fixPosition(pos: vscode.Position): vscode.Position {
        // Since json format treats tabs as **8** characters, we need to offset it.
        let charPos = pos.character;
        const s = this.textDocument.getText(new vscode.Range(pos.with({ character: 0 }), pos));
        for (const ch of s) {
            if (ch === '\t') {
                charPos -= 7;
            }
        }

        return pos.with({ character: charPos });
    }
}

class Json1Parser extends JsonParserMixin implements Parser {
    public readonly outputFormat = 'json1';

    constructor(public readonly textDocument: vscode.TextDocument) {
        super();
    }

    public parse(s: string): ParseResult[] {
        const result = <{ comments: ShellCheckItem[] }>JSON.parse(s);
        return this.doParse(this.textDocument, result.comments);
    }
}

function levelToDiagnosticSeverity(level: string): vscode.DiagnosticSeverity {
    switch (level) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'style':
        /* falls through */
        case 'info':
            return vscode.DiagnosticSeverity.Information;
        case 'warning':
        /* falls through */
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

function scCodeToDiagnosticTags(code: number): vscode.DiagnosticTag[] | undefined {
    // SC2034 - https://github.com/koalaman/shellcheck/wiki/SC2034
    if (code === 2034) {
        return [vscode.DiagnosticTag.Unnecessary];
    }

    return undefined;
}

export function createParser(textDocument: vscode.TextDocument, toolVersion?: semver.SemVer | null): Parser {
    if (toolVersion && semver.gte(toolVersion, BEST_TOOL_VERSION)) {
        return new Json1Parser(textDocument);
    }

    return new JsonParser(textDocument);
}
