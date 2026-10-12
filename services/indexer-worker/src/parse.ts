import { createRequire } from "node:module";

// Minimal structural view of web-tree-sitter (the package ships a non-module d.ts, so we type what we use).
export interface TsNode {
  type: string; text: string; startIndex: number; endIndex: number;
  startPosition: { row: number }; endPosition: { row: number };
  namedChildren: (TsNode | null)[]; parent: TsNode | null;
  childForFieldName(name: string): TsNode | null;
}
interface TsParser { setLanguage(l: unknown): void; parse(src: string): { rootNode: TsNode; delete(): void } | null; delete(): void }
interface TreeSitter { Parser: { new (): TsParser; init(): Promise<void> }; Language: { load(path: string): Promise<unknown> } }

export type Lang = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "ruby";
export type EntityKind = "function" | "method" | "class" | "interface" | "type";
export interface Entity {
  name: string; kind: EntityKind; fqName: string; startLine: number; endLine: number; startIndex: number; endIndex: number; parent?: string;
  /** Declared base classes / interfaces (classes only), last name segment, generics stripped. */
  bases?: string[];
  /** Abstract member (abstractmethod / abstract keyword / raise NotImplementedError body) or abstract class. */
  abstract?: boolean;
}
export interface Edge { kind: "call" | "import" | "var"; dstName: string; line: number; src?: string /* fqName of enclosing entity */ }
export interface ParsedFile { language: Lang; entities: Entity[]; edges: Edge[]; imports: string[] }

const EXT: Record<string, Lang> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", java: "java", rs: "rust", rb: "ruby",
};
export const detectLanguage = (path: string): Lang | undefined => EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];

const req = createRequire(import.meta.url);
let ts: Promise<TreeSitter> | undefined;
const langs = new Map<Lang, Promise<unknown>>();
async function parserFor(lang: Lang): Promise<TsParser> {
  ts ??= (async () => { const m = req("@vscode/tree-sitter-wasm") as TreeSitter; await m.Parser.init(); return m; })();
  const m = await ts;
  let l = langs.get(lang);
  if (!l) { l = m.Language.load(req.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${lang}.wasm`)); langs.set(lang, l); }
  const p = new m.Parser();
  p.setLanguage(await l);
  return p;
}

const JS_DECL: Record<string, EntityKind> = {
  function_declaration: "function", generator_function_declaration: "function", class_declaration: "class", abstract_class_declaration: "class",
  method_definition: "method", abstract_method_signature: "method", interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "type",
};
/** Per-language node types. ponytail: hand-written maps instead of .scm tag queries; switch to upstream tags.scm when more languages land. */
const SPEC: Record<Lang, { decl: Record<string, EntityKind>; call: string[]; imports: string[]; ident: string[] }> = {
  typescript: { decl: JS_DECL, call: ["call_expression", "new_expression"], imports: ["import_statement"], ident: ["identifier"] },
  tsx: { decl: JS_DECL, call: ["call_expression", "new_expression"], imports: ["import_statement"], ident: ["identifier"] },
  javascript: { decl: JS_DECL, call: ["call_expression", "new_expression"], imports: ["import_statement"], ident: ["identifier"] },
  python: { decl: { function_definition: "function", class_definition: "class" }, call: ["call"], imports: ["import_statement", "import_from_statement"], ident: ["identifier"] },
  go: { decl: { function_declaration: "function", method_declaration: "method", type_spec: "type" }, call: ["call_expression"], imports: ["import_spec"], ident: ["identifier"] },
  java: {
    decl: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "class", record_declaration: "class", method_declaration: "method", constructor_declaration: "method" },
    call: ["method_invocation", "object_creation_expression"], imports: ["import_declaration"], ident: ["identifier"],
  },
  ruby: { decl: { class: "class", module: "class", method: "method", singleton_method: "method" }, call: ["call"], imports: [], ident: ["identifier"] },
  rust: {
    decl: { function_item: "function", struct_item: "class", enum_item: "class", trait_item: "interface", type_item: "type", impl_item: "class" },
    call: ["call_expression", "macro_invocation"], imports: ["use_declaration"], ident: ["identifier"],
  },
};

const line = (n: TsNode) => n.startPosition.row + 1;
const kids = (n: TsNode) => n.namedChildren.filter((c): c is TsNode => c !== null);
const lastSeg = (s: string) => s.split(/::|\.|\//).filter(Boolean).pop() ?? s;

function entityName(n: TsNode, lang: Lang): string | undefined {
  if (lang === "rust" && n.type === "impl_item") return n.childForFieldName("type")?.text;
  return n.childForFieldName("name")?.text;
}

const stripGenerics = (s: string) => s.replace(/[[<][\s\S]*$/, "").trim();
/** Base class names of a class node (python superclasses, TS/Java extends+implements, ruby superclass). */
function basesOf(n: TsNode, lang: Lang): string[] {
  const out: string[] = [];
  const add = (t: string | undefined) => { const s = t && lastSeg(stripGenerics(t)); if (s && /^[A-Za-z_]\w*$/.test(s) && s !== "object") out.push(s); };
  if (lang === "python") {
    for (const a of kids(n.childForFieldName("superclasses") ?? ({ namedChildren: [] } as unknown as TsNode))) if (a.type !== "keyword_argument") add(a.text);
  } else if (lang === "ruby") add(n.childForFieldName("superclass")?.text.replace(/^<\s*/, ""));
  else if (lang === "java") {
    add(n.childForFieldName("superclass")?.text.replace(/^extends\s+/, ""));
    for (const t of (n.childForFieldName("interfaces")?.text.replace(/^implements\s+/, "") ?? "").split(",")) add(t);
  } else if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
    const h = kids(n).find((c) => c.type === "class_heritage");
    for (const cl of h ? kids(h) : []) for (const t of cl.text.replace(/^(extends|implements)\s+/, "").split(",")) add(t);
  }
  return out;
}

/** Abstract markers: python @abstractmethod / NotImplementedError body, TS/Java abstract modifier. */
function isAbstract(n: TsNode, lang: Lang): boolean {
  if (lang === "python") {
    const deco = n.parent?.type === "decorated_definition" ? n.parent.text.slice(0, n.startIndex - n.parent.startIndex) : "";
    if (/@(abc\.)?abstract(method|property)/.test(deco)) return true;
    const body = n.childForFieldName("body");
    const stmts = body ? kids(body).filter((s) => s.type !== "expression_statement" || !/^("""|'''|"|')/.test(s.text)) : [];
    return stmts.length === 1 && /^raise\s+NotImplementedError/.test(stmts[0]!.text);
  }
  if (n.type === "abstract_method_signature" || n.type === "abstract_class_declaration") return true;
  if (lang === "java") return /\babstract\b/.test(kids(n).find((c) => c.type === "modifiers")?.text ?? "");
  return false;
}

function refineKind(n: TsNode, kind: EntityKind, inClass: boolean, lang: Lang): EntityKind {
  if (lang === "go" && n.type === "type_spec") {
    const t = n.childForFieldName("type")?.type;
    return t === "struct_type" ? "class" : t === "interface_type" ? "interface" : "type";
  }
  return kind === "function" && inClass ? "method" : kind;
}

function calleeName(n: TsNode): string | undefined {
  if (n.type === "call" && n.childForFieldName("method")) return n.childForFieldName("method")!.text;
  const f = n.childForFieldName("function") ?? n.childForFieldName("constructor") ?? n.childForFieldName("macro")
    ?? (n.type === "object_creation_expression" ? n.childForFieldName("type") : null);
  if (n.type === "method_invocation") return n.childForFieldName("name")?.text;
  if (!f) return undefined;
  const prop = f.childForFieldName("property") ?? f.childForFieldName("attribute") ?? f.childForFieldName("field") ?? f.childForFieldName("name");
  return lastSeg((prop ?? f).text.replace(/<.*$/s, ""));
}

function importNames(n: TsNode, lang: Lang): string[] {
  switch (lang) {
    case "python": {
      const out: string[] = [];
      const mod = n.childForFieldName("module_name");
      if (mod) out.push(mod.text);
      for (const c of kids(n)) if (c.startIndex !== mod?.startIndex && (c.type === "dotted_name" || c.type === "aliased_import")) out.push((c.childForFieldName("name") ?? c).text);
      return out;
    }
    case "go": { const p = n.childForFieldName("path"); return p ? [p.text.replace(/^"|"$/g, "")] : []; }
    case "java": return kids(n).filter((c) => c.type !== "asterisk").map((c) => c.text);
    case "rust": { const a = n.childForFieldName("argument"); return a ? [a.text] : []; }
    default: {
      const out: string[] = [];
      const src = n.childForFieldName("source");
      if (src) out.push(src.text.replace(/^['"`]|['"`]$/g, ""));
      const walk = (x: TsNode) => {
        if (x.type === "import_specifier") { const nm = x.childForFieldName("name"); if (nm) out.push(nm.text); return; }
        if (x.type === "namespace_import" || (x.type === "identifier" && x.parent?.type === "import_clause")) { out.push(x.text); return; }
        kids(x).forEach(walk);
      };
      kids(n).filter((c) => c !== src).forEach(walk);
      return out;
    }
  }
}

/** Names of module-level variables/consts (not functions) declared directly in the root. */
function moduleVars(root: TsNode, lang: Lang): Set<string> {
  const out = new Set<string>();
  for (let c of kids(root)) {
    if (c.type === "export_statement") c = c.childForFieldName("declaration") ?? c;
    if (c.type === "expression_statement" && lang === "python") {
      const a = kids(c)[0];
      const l = a?.type === "assignment" ? a.childForFieldName("left") : null;
      if (l?.type === "identifier") out.add(l.text);
    } else if (["lexical_declaration", "variable_declaration", "const_declaration", "var_declaration", "const_item", "static_item"].includes(c.type)) {
      const decls = c.type === "const_item" || c.type === "static_item" ? [c] : kids(c).filter((d) => /declarator|spec$/.test(d.type));
      for (const d of decls) {
        const v = d.childForFieldName("value");
        if (v && /arrow_function|function_expression|^function$/.test(v.type)) continue;
        const nm = d.childForFieldName("name");
        if (nm && /identifier/.test(nm.type)) out.add(nm.text);
        else if (!nm) for (const i of kids(d)) if (i.type === "identifier") out.add(i.text); // go var_spec/const_spec name list
      }
    }
  }
  return out;
}

export async function parseSource(path: string, source: string, lang: Lang | undefined = detectLanguage(path)): Promise<ParsedFile | undefined> {
  if (!lang) return undefined;
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) return undefined;
  try {
    const spec = SPEC[lang];
    const entities: Entity[] = [];
    const edges: Edge[] = [];
    const imports: string[] = [];
    const vars = moduleVars(tree.rootNode, lang);
    const seenVar = new Set<string>();

    const visit = (n: TsNode, owner: Entity | undefined, cls: Entity | undefined) => {
      let kind = spec.decl[n.type];
      let name = kind ? entityName(n, lang) : undefined;
      // `const f = () => ...` at module level counts as a function.
      if (!kind && n.type === "variable_declarator" && !owner) {
        const v = n.childForFieldName("value");
        if (v && /arrow_function|function_expression|^function$/.test(v.type)) { kind = "function"; name = n.childForFieldName("name")?.text; }
      }
      let ent: Entity | undefined;
      if (kind && name) {
        // Go methods attach to their receiver type.
        let parentName = cls?.name;
        if (lang === "go" && n.type === "method_declaration") parentName = n.childForFieldName("receiver")?.text.match(/(\w+)\s*\)$/)?.[1];
        const k = refineKind(n, kind, !!cls, lang);
        // Rust impl blocks are containers, not entities of their own; methods get the impl type as parent.
        if (!(lang === "rust" && n.type === "impl_item")) {
          const fqLocal = parentName && k === "method" ? `${parentName}.${name}` : name;
          ent = { name, kind: k, fqName: `${path}#${fqLocal}`, startLine: line(n), endLine: n.endPosition.row + 1, startIndex: n.startIndex, endIndex: n.endIndex, ...(parentName && k === "method" ? { parent: parentName } : {}) };
          if (k === "class" || k === "interface") { const b = basesOf(n, lang); if (b.length) ent.bases = b; }
          if (isAbstract(n, lang)) ent.abstract = true;
          if (n.type === "variable_declarator" && n.parent) { // span the whole declaration statement
            const decl = n.parent.parent?.type === "export_statement" ? n.parent.parent : n.parent;
            Object.assign(ent, { startLine: line(decl), endLine: decl.endPosition.row + 1, startIndex: decl.startIndex, endIndex: decl.endIndex });
          }
          entities.push(ent);
        }
      }
      const nextOwner = ent ?? owner;
      const isClass = (kind === "class" || kind === "interface") && name;
      const nextCls = isClass ? (ent ?? { name: name!, kind: "class", fqName: "", startLine: 0, endLine: 0, startIndex: 0, endIndex: 0 }) : cls;
      if (spec.call.includes(n.type)) {
        const callee = calleeName(n);
        if (callee) edges.push({ kind: "call", dstName: callee, line: line(n), ...(nextOwner ? { src: nextOwner.fqName } : {}) });
      } else if (spec.imports.includes(n.type)) {
        for (const nm of importNames(n, lang)) { imports.push(nm); edges.push({ kind: "import", dstName: nm, line: line(n) }); }
        return;
      } else if (spec.ident.includes(n.type) && nextOwner && vars.has(n.text)) {
        const key = `${nextOwner.fqName}|${n.text}`;
        if (!seenVar.has(key)) { seenVar.add(key); edges.push({ kind: "var", dstName: n.text, line: line(n), src: nextOwner.fqName }); }
      }
      for (const c of kids(n)) visit(c, nextOwner, nextCls);
    };
    visit(tree.rootNode, undefined, undefined);
    return { language: lang, entities, edges, imports };
  } finally {
    tree.delete();
  }
}
