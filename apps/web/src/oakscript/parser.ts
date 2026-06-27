import { Token, tokenize } from './lexer';
import type { ASTNode, Program, VarDecl, IfStatement, ForStatement, WhileStatement,
  BreakStmt, ContinueStmt, ReturnStmt, ExpressionStmt, BinaryExpr, UnaryExpr,
  CallExpr, IndexExpr, MemberExpr, Identifier, NumberLiteral, StringLiteral,
  BooleanLiteral, ArrayLiteral, NilLiteral } from './ast';

export class ParseError extends Error {
  constructor(message: string, public token: Token) {
    super(`Parse error at line ${token.line}, col ${token.col}: ${message}`);
  }
}

export function parse(source: string): Program {
  const tokens = tokenize(source);
  const p = new Parser(tokens);
  const statements: ASTNode[] = [];
  while (!p.isEOF()) {
    const stmt = p.parseStatement();
    if (stmt) statements.push(stmt);
  }
  return { type: 'Program', statements };
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(offset = 0): Token {
    const idx = this.pos + offset;
    return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: string, value?: string): Token {
    const t = this.peek();
    if (t.type === 'EOF') throw new ParseError(`Expected ${type} "${value || ''}" but got EOF`, t);
    if (type === 'OPERATOR' && value && t.value !== value)
      throw new ParseError(`Expected operator "${value}" but got "${t.value}"`, t);
    if (type === 'PUNCTUATION' && value && t.value !== value)
      throw new ParseError(`Expected "${value}" but got "${t.value}"`, t);
    if (t.type !== type) throw new ParseError(`Expected ${type} but got ${t.type}`, t);
    return this.advance();
  }

  private match(type: string, value?: string): boolean {
    const t = this.peek();
    if (t.type === 'EOF') return false;
    if (type === 'KEYWORD' && t.type === 'KEYWORD') return value ? t.value === value : true;
    if (type === 'OPERATOR' && t.type === 'OPERATOR') return value ? t.value === value : true;
    if (type === 'PUNCTUATION' && t.type === 'PUNCTUATION') return value ? t.value === value : true;
    return t.type === type;
  }

  public isEOF(): boolean { return this.peek().type === 'EOF'; }

  parseStatement(): ASTNode | null {
    // Skip semicolons
    while (this.match('PUNCTUATION', ';')) this.advance();
    if (this.isEOF()) return null;

    if (this.match('KEYWORD', 'var') || this.match('KEYWORD', 'varip')) return this.parseVarDecl();
    if (this.match('KEYWORD', 'if')) return this.parseIf();
    if (this.match('KEYWORD', 'for')) return this.parseFor();
    if (this.match('KEYWORD', 'while')) return this.parseWhile();
    if (this.match('KEYWORD', 'break')) { this.advance(); return { type: 'Break' } as BreakStmt; }
    if (this.match('KEYWORD', 'continue')) { this.advance(); return { type: 'Continue' } as ContinueStmt; }
    if (this.match('KEYWORD', 'return')) { this.advance(); const v = this.parseExpression(); return { type: 'Return', value: v } as ReturnStmt; }

    return this.parseExpressionStmt();
  }

  private parseVarDecl(): VarDecl {
    const kw = this.advance().value;
    const isVarip = kw === 'varip';
    const isVar = kw === 'var' || isVarip;
    const name = this.expect('IDENTIFIER').value;

    let value: ASTNode = { type: 'NilLiteral' };
    if (this.match('OPERATOR', '=')) {
      this.advance();
      value = this.parseExpression();
    }
    return { type: 'VarDecl', name, value, isVar, isVarip };
  }

  private parseIf(): IfStatement {
    this.advance(); // 'if'
    const condition = this.parseExpression();
    const body = this.parseBlock();
    let elseBody: ASTNode[] = [];
    if (this.match('KEYWORD', 'else')) {
      this.advance();
      elseBody = this.parseBlock();
    }
    return { type: 'IfStatement', condition, body, elseBody };
  }

  private parseFor(): ForStatement {
    this.advance(); // 'for'
    const idTok = this.peek();
    if (idTok.type === 'IDENTIFIER') {
      const idName = idTok.value;
      this.advance();
      // for id = start to end [by step]
      if (this.match('OPERATOR', '=')) {
        this.advance();
        const startExpr = this.parseExpression();
        if (this.match('KEYWORD', 'to')) {
          this.advance();
          const endExpr = this.parseExpression();
          let stepExpr: ASTNode = { type: 'NumberLiteral', value: 1 };
          if (this.match('KEYWORD', 'by')) { this.advance(); stepExpr = this.parseExpression(); }
          return {
            type: 'ForStatement',
            init: { type: 'VarDecl', name: idName, value: startExpr, isVar: true, isVarip: false },
            condition: { type: 'BinaryExpr', left: { type: 'Identifier', name: idName }, op: '<=', right: endExpr } as BinaryExpr,
            update: { type: 'Assignment', target: { type: 'Identifier', name: idName }, value: { type: 'BinaryExpr', left: { type: 'Identifier', name: idName }, op: '+', right: stepExpr } } as unknown as ASTNode,
            body: this.parseBlock(),
          } as ForStatement;
        }
        if (this.match('KEYWORD', 'downto')) {
          this.advance();
          const endExpr = this.parseExpression();
          let stepExpr: ASTNode = { type: 'NumberLiteral', value: 1 };
          if (this.match('KEYWORD', 'by')) { this.advance(); stepExpr = this.parseExpression(); }
          return {
            type: 'ForStatement',
            init: { type: 'VarDecl', name: idName, value: startExpr, isVar: true, isVarip: false },
            condition: { type: 'BinaryExpr', left: { type: 'Identifier', name: idName }, op: '>=', right: endExpr } as BinaryExpr,
            update: { type: 'Assignment', target: { type: 'Identifier', name: idName }, value: { type: 'BinaryExpr', left: { type: 'Identifier', name: idName }, op: '-', right: stepExpr } } as unknown as ASTNode,
            body: this.parseBlock(),
          } as ForStatement;
        }
        // Plain assignment — rewind and treat as expression
        this.pos -= 2;
        return this.parseExpressionStmt() as unknown as ForStatement;
      }
      // for id in container
      if (this.match('KEYWORD', 'in')) {
        this.advance();
        const container = this.parseExpression();
        return {
          type: 'ForStatement',
          init: { type: 'VarDecl', name: idName, value: { type: 'NumberLiteral', value: 0 }, isVar: true, isVarip: false },
          condition: null,
          update: null,
          body: this.parseBlock(),
          forInIdx: idName,
          forInContainer: container,
        } as ForStatement;
      }
      // Not a for-loop construct — could be expression start, rewind
      this.pos--;
    }
    // Standard C-style for: for(var decl; cond; upd) body
    const init = this.parseVarDecl();
    this.expect('PUNCTUATION', ';');
    const condition = this.parseExpression();
    this.expect('PUNCTUATION', ';');
    const update = this.parseExpression();
    const body = this.parseBlock();
    return { type: 'ForStatement', init, condition, update, body };
  }

  private parseWhile(): WhileStatement {
    this.advance(); // 'while'
    const condition = this.parseExpression();
    const body = this.parseBlock();
    return { type: 'WhileStatement', condition, body };
  }

  private parseBlock(): ASTNode[] {
    // Support implicit single-statement block (PineScript style, no braces)
    if (!this.match('PUNCTUATION', '{')) {
      const s = this.parseStatement();
      return s ? [s] : [];
    }
    this.advance(); // '{'
    const stmts: ASTNode[] = [];
    while (!this.isEOF() && !this.match('PUNCTUATION', '}')) {
      const s = this.parseStatement();
      if (s) stmts.push(s);
    }
    this.expect('PUNCTUATION', '}');
    return stmts;
  }

  private parseExpressionStmt(): ExpressionStmt {
    const expr = this.parseExpression();
    return { type: 'ExpressionStmt', expression: expr };
  }

  // Expression precedence
  private parseExpression(): ASTNode {
    return this.parseAssignment();
  }

  private parseAssignment(): ASTNode {
    let left = this.parseOr();
    if (this.match('OPERATOR', '=') || this.match('OPERATOR', ':=')) {
      const op = this.advance().value;
      const right = this.parseAssignment();
      return { type: 'Assignment', target: left, value: right } as unknown as ASTNode;
    }
    return left;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.match('KEYWORD', 'or')) {
      this.advance();
      left = { type: 'BinaryExpr', left, op: 'or', right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseComparison();
    while (this.match('KEYWORD', 'and')) {
      this.advance();
      left = { type: 'BinaryExpr', left, op: 'and', right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): ASTNode {
    let left = this.parseAddSub();
    const ops = new Set(['==', '!=', '<', '>', '<=', '>=', '=>']);
    while (this.match('OPERATOR') && ops.has(this.peek().value)) {
      const op = this.advance().value;
      left = { type: 'BinaryExpr', left, op, right: this.parseAddSub() };
    }
    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();
    while (this.match('OPERATOR') && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value;
      left = { type: 'BinaryExpr', left, op, right: this.parseMulDiv() };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parseUnary();
    while (this.match('OPERATOR') && '*/%'.includes(this.peek().value)) {
      const op = this.advance().value;
      left = { type: 'BinaryExpr', left, op, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    if (this.match('OPERATOR') && (this.peek().value === '-' || this.peek().value === '!')) {
      const op = this.advance().value;
      return { type: 'UnaryExpr', op, argument: this.parseUnary() };
    }
    if (this.match('KEYWORD', 'not')) {
      this.advance();
      return { type: 'UnaryExpr', op: 'not', argument: this.parseUnary() };
    }
    return this.parseCall();
  }

  private parseCall(): ASTNode {
    let expr = this.parsePrimary();
    while (true) {
      if (this.match('PUNCTUATION', '(')) {
        this.advance();
        const args: ASTNode[] = [];
        if (!this.match('PUNCTUATION', ')')) {
          args.push(this.parseExpression());
          while (this.match('PUNCTUATION', ',')) {
            this.advance();
            args.push(this.parseExpression());
          }
        }
        this.expect('PUNCTUATION', ')');
        expr = { type: 'CallExpr', callee: expr, args } as CallExpr;
      } else if (this.match('PUNCTUATION', '[')) {
        this.advance();
        const index = this.parseExpression();
        this.expect('PUNCTUATION', ']');
        expr = { type: 'IndexExpr', object: expr, index } as IndexExpr;
      } else if (this.match('PUNCTUATION', '.') && (this.peek(1)?.type === 'IDENTIFIER' || this.peek(1)?.type === 'KEYWORD')) {
        this.advance();
        const prop = this.advance().value;
        expr = { type: 'MemberExpr', object: expr, property: prop } as MemberExpr;
      } else break;
    }
    return expr;
  }

  private parsePrimary(): ASTNode {
    const t = this.peek();
    if (t.type === 'NUMBER') {
      this.advance();
      return { type: 'NumberLiteral', value: parseFloat(t.value) } as NumberLiteral;
    }
    if (t.type === 'STRING') {
      this.advance();
      return { type: 'StringLiteral', value: t.value } as StringLiteral;
    }
    if (t.type === 'KEYWORD') {
      if (t.value === 'true') { this.advance(); return { type: 'BooleanLiteral', value: true }; }
      if (t.value === 'false') { this.advance(); return { type: 'BooleanLiteral', value: false }; }
      if (t.value === 'nil') { this.advance(); return { type: 'NilLiteral' }; }
      // Treat as identifier
      this.advance();
      return { type: 'Identifier', name: t.value } as Identifier;
    }
    if (t.type === 'IDENTIFIER') {
      this.advance();
      return { type: 'Identifier', name: t.value } as Identifier;
    }
    if (t.type === 'PUNCTUATION' && t.value === '(') {
      this.advance();
      const expr = this.parseExpression();
      this.expect('PUNCTUATION', ')');
      return expr;
    }
    if (t.type === 'PUNCTUATION' && t.value === '[') {
      this.advance();
      const elements: ASTNode[] = [];
      if (!this.match('PUNCTUATION', ']')) {
        elements.push(this.parseExpression());
        while (this.match('PUNCTUATION', ',')) {
          this.advance();
          elements.push(this.parseExpression());
        }
      }
      this.expect('PUNCTUATION', ']');
      return { type: 'ArrayLiteral', elements } as ArrayLiteral;
    }
    throw new ParseError(`Unexpected token "${t.value}"`, t);
  }
}
