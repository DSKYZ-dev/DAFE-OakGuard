export type ASTNode =
  | Program | VarDecl | Assignment | IfStatement | ForStatement | WhileStatement
  | BreakStmt | ContinueStmt | ReturnStmt | ExpressionStmt | FunctionDecl
  | BinaryExpr | UnaryExpr | TernaryExpr | CallExpr | IndexExpr | MemberExpr
  | Identifier | NumberLiteral | StringLiteral | BooleanLiteral | ArrayLiteral | NilLiteral;

export interface Program { type: 'Program'; statements: ASTNode[]; }
export interface VarDecl { type: 'VarDecl'; name: string; value: ASTNode; isVar: boolean; isVarip: boolean; }
export interface Assignment { type: 'Assignment'; target: ASTNode; value: ASTNode; }
export interface IfStatement { type: 'IfStatement'; condition: ASTNode; body: ASTNode[]; elseBody: ASTNode[]; }
export interface ForStatement { type: 'ForStatement'; init: VarDecl | null; condition: ASTNode | null; update: ASTNode | null; body: ASTNode[]; forInIdx?: string; forInContainer?: ASTNode; }
export interface WhileStatement { type: 'WhileStatement'; condition: ASTNode; body: ASTNode[]; }
export interface BreakStmt { type: 'Break'; }
export interface ContinueStmt { type: 'Continue'; }
export interface ReturnStmt { type: 'Return'; value: ASTNode | null; }
export interface ExpressionStmt { type: 'ExpressionStmt'; expression: ASTNode; }
// User-defined function: f(a, b) => expr  |  f(a, b) => { stmts; return v }
// (Pine-style arrow functions. body is a statement list; a single-expression
// body is stored as one ReturnStmt.)
export interface FunctionDecl { type: 'FunctionDecl'; name: string; params: string[]; body: ASTNode[]; }

export interface BinaryExpr { type: 'BinaryExpr'; left: ASTNode; op: string; right: ASTNode; }
export interface UnaryExpr { type: 'UnaryExpr'; op: string; argument: ASTNode; }
export interface TernaryExpr { type: 'TernaryExpr'; condition: ASTNode; consequent: ASTNode; alternate: ASTNode; }
export interface CallExpr { type: 'CallExpr'; callee: ASTNode; args: ASTNode[]; }
export interface IndexExpr { type: 'IndexExpr'; object: ASTNode; index: ASTNode; }
export interface MemberExpr { type: 'MemberExpr'; object: ASTNode; property: string; }

export interface Identifier { type: 'Identifier'; name: string; }
export interface NumberLiteral { type: 'NumberLiteral'; value: number; }
export interface StringLiteral { type: 'StringLiteral'; value: string; }
export interface BooleanLiteral { type: 'BooleanLiteral'; value: boolean; }
export interface ArrayLiteral { type: 'ArrayLiteral'; elements: ASTNode[]; }
export interface NilLiteral { type: 'NilLiteral'; }
