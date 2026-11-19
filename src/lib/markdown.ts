import MarkdownIt from 'markdown-it';

/** Ruta relativa a la nota (no es URL absoluta, ni ancla, ni correo). */
export function isRelativeRef(href: string): boolean {
  return !!href && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
}

type MD = InstanceType<typeof MarkdownIt>;

let instance: MD | null = null;

function create(): MD {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

  // Listas de tareas: "- [ ] algo" → casilla que se puede marcar (data-line = línea en el texto).
  md.core.ruler.after('inline', 'tinta-tasks', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\][  ]+/.exec(t.content);
      if (!m) continue;
      const checked = m[1] !== ' ';
      const line = tokens[i - 2].map?.[0] ?? -1;
      const first = t.children?.[0];
      if (first?.type === 'text') first.content = first.content.replace(/^\[([ xX])\][  ]+/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="task-box" data-line="${line}"${checked ? ' checked' : ''} aria-label="Tarea">`;
      t.children?.unshift(box);
      tokens[i - 2].attrJoin('class', checked ? 'task done' : 'task');
    }
  });

  // Imágenes relativas: se resuelven después contra el árbol de Drive (data-src).
  const image = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const src = String(t.attrGet('src') ?? '');
    if (isRelativeRef(src) || src.startsWith('tinta-embed:')) {
      t.attrSet('data-src', src);
      t.attrSet('src', 'data:,');
      t.attrSet('loading', 'lazy');
    }
    return image(tokens, idx, options, env, self);
  };

  // Enlaces: los externos se abren aparte; los relativos se marcan para abrirlos en la app.
  const linkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const href = String(t.attrGet('href') ?? '');
    if (isRelativeRef(href)) t.attrSet('data-rel', href);
    else {
      t.attrSet('target', '_blank');
      t.attrSet('rel', 'noopener noreferrer');
    }
    return linkOpen(tokens, idx, options, env, self);
  };

  // Permite el esquema interno de los embebidos estilo Obsidian.
  const validate = md.validateLink.bind(md);
  md.validateLink = (url) => url.startsWith('tinta-embed:') || validate(url);
  return md;
}

/** "![[foto.png]]" (estilo Obsidian) → imagen embebida que se busca por nombre. */
function obsidianEmbeds(src: string): string {
  return src.replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g, (_m, name: string) => `![${name}](tinta-embed:${encodeURIComponent(name.trim())})`);
}

export function renderMarkdown(src: string): string {
  instance ??= create();
  return instance.render(obsidianEmbeds(src));
}

/** Divide una ruta relativa ("../Fotos/a%20b.png") en segmentos limpios. */
export function splitRelPath(href: string): string[] {
  const clean = href.replace(/^<|>$/g, '').split(/[?#]/)[0];
  return clean
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter((s) => s !== '' && s !== '.');
}
