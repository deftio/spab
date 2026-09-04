/*
 * site.js — shared site chrome for every spab page.
 *
 * One place defines the whole look and the whole shell: the design tokens, the
 * header and nav, the theme toggle, the footer, and the router wiring. A page
 * supplies only its routes and its views; it never rebuilds the chrome, and no
 * page can drift from the others because there is nothing to keep in sync.
 *
 * Everything here is bitwrench doing the work it was built for:
 *
 *   bw.loadStyles()     derives an entire coordinated design system — every
 *                       component's colors, radii, spacing, elevation and type
 *                       scale — from a handful of seed values in SITE.theme.
 *                       Changing the site's whole appearance is editing that
 *                       object, not hunting through stylesheets.
 *   bw.setThemeMode()   light/dark by toggling the generated alternate palette.
 *                       No second stylesheet to maintain.
 *   bw.router()         URL -> view, with real history, deep links and a
 *                       `bw:route` event, replacing a hand-rolled hashchange
 *                       listener and an if/else chain.
 *   bw.sub('bw:route')  the nav re-renders its active state by subscribing to
 *                       route changes rather than being repainted by the router.
 *   make*()             real components (navbar, hero, section, cards, grids)
 *                       instead of hand-assembled div trees.
 *
 * Usage from a page:
 *
 *   SPABSite.start({
 *     routes: {
 *       '/':      function () { return homeView(); },
 *       '/how':   function () { return howView(); },
 *       '*':      function () { return SPABSite.notFound(); }
 *     }
 *   });
 *
 * Depends on bitwrench 2.x being loaded first (window.bw).
 */
(function (root) {
  'use strict';

  var bw = root.bw;
  if (!bw) throw new Error('site.js: bitwrench (window.bw) must load first');

  // ── Design tokens ─────────────────────────────────────────────────────
  //
  // The single source of truth for how the site looks. bitwrench derives nine
  // color families of eight shades each from these seeds, plus a full alternate
  // (dark) palette, and styles every component from them. Retheming the site is
  // editing this object.
  var SITE = {
    brand: 'spab',
    tagline: 'robust text watermarking',
    github: 'https://github.com/deftio/spab',
    npm: '@deftio/spab',

    nav: [
      { path: '/',          text: 'Home' },
      { path: '/how',       text: 'How it works' },
      { path: '/test',      text: 'Playground' },
      { path: '/libraries', text: 'Libraries' }
    ],

    theme: {
      primary:   '#3457d5',   // ink blue — links, primary actions
      secondary: '#c2410c',   // warm accent — carrier highlights, emphasis
      tertiary:  '#0891b2',   // cool accent — data viz, badges
      background: '#ffffff',
      surface:   '#f7f8fa',
      radius:    'lg',
      elevation: 'sm',
      spacing:   'normal',
      typeRatio: 'relaxed',   // generous heading scale — the 2002 look is a flat one
      motion:    'standard',
      harmonize: 0.22         // pull semantic colors toward the brand hue
    }
  };

  var THEME_KEY = 'spab.theme';   // 'light' | 'dark'

  // ── Theme ─────────────────────────────────────────────────────────────

  // Respect a stored choice, else follow the OS. Read defensively: a browser
  // with site data blocked throws on localStorage access rather than returning
  // null, and that must not take the page down.
  function preferredTheme() {
    try {
      var saved = root.localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) { /* storage unavailable — fall through to the OS preference */ }
    try {
      if (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) { /* no matchMedia — default light */ }
    return 'light';
  }

  function applyTheme(mode) {
    // 'alternate' is the generated counterpart palette; 'primary' is the base.
    bw.setThemeMode(mode === 'dark' ? 'alternate' : 'primary');
    try { root.localStorage.setItem(THEME_KEY, mode); } catch (e) { /* not fatal */ }
    state.theme = mode;
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    paintNav();   // the toggle's own label lives in the nav
  }

  var state = { theme: 'light', path: '/' };

  // ── Site-level CSS ────────────────────────────────────────────────────
  //
  // bitwrench styles the components; this is only the page furniture it cannot
  // know about — the shell layout, the sticky header, prose measure, and the
  // carrier-visualisation marks specific to spab.
  //
  // Split in two on purpose. Geometry (widths, grids, rhythm) does not change
  // with the theme, so it is injected once. Everything that reads a palette
  // value is a function OF the palette, injected twice: once for the primary
  // palette and once scoped under `.bw_theme_alt` with the generated alternate.
  // Without that second pass the components would flip to dark while the page
  // furniture around them stayed white — the shell has to theme with them.

  function staticRules() {
    return {
      'html': { scrollBehavior: 'smooth' },
      'body': { margin: '0', fontFeatureSettings: '"kern","liga","calt"',
        textRendering: 'optimizeLegibility', WebkitFontSmoothing: 'antialiased' },

      '.site': { minHeight: '100vh', display: 'flex', flexDirection: 'column' },
      '.site-main': { flex: '1 0 auto' },
      '.wrap': { width: '100%', maxWidth: '1240px', margin: '0 auto', padding: '0 20px', boxSizing: 'border-box' },

      '.site-head .wrap': { display: 'flex', alignItems: 'center', gap: '4px', height: '62px' },
      '.brand': { display: 'inline-flex', alignItems: 'baseline', gap: '9px',
        textDecoration: 'none', marginRight: 'auto' },
      '.brand b': { fontSize: '21px', fontWeight: '800', letterSpacing: '-.02em' },
      '.brand span': { fontSize: '12.5px', opacity: '.6', letterSpacing: '.01em' },

      '.navlink': { textDecoration: 'none', padding: '7px 12px', borderRadius: '9px',
        fontSize: '14px', fontWeight: '500', opacity: '.78',
        transition: 'background .15s ease, opacity .15s ease' },
      '.navlink:hover': { opacity: '1' },
      '.navlink.is-active': { opacity: '1', fontWeight: '600' },

      '.icon-btn': { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '34px', height: '34px', marginLeft: '6px', borderRadius: '9px',
        background: 'transparent', cursor: 'pointer', opacity: '.8' },
      '.icon-btn:hover': { opacity: '1' },

      '.section': { padding: '52px 0' },
      '.section-tight': { padding: '30px 0' },
      '.prose': { maxWidth: '68ch', lineHeight: '1.72', fontSize: '16.5px' },
      '.lede': { maxWidth: '72ch', fontSize: '18.5px', lineHeight: '1.6', opacity: '.8', marginTop: '10px' },
      '.eyebrow': { textTransform: 'uppercase', letterSpacing: '.09em', fontSize: '11.5px',
        fontWeight: '700', margin: '0 0 10px' },

      // Cards size to their own content here. bitwrench sets height:100% on
      // .bw_bccl_card so a row of cards matches height, which is right for a row of
      // equal peers — but these two hold very different amounts, and matching them
      // left a tall empty void under the shorter one. Both parts are needed:
      // align-items stops the grid stretching the item, height:auto stops the card
      // filling the stretched area.
      '.grid2': { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))',
        gap: '20px', alignItems: 'start' },
      '.grid3': { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))',
        gap: '18px', alignItems: 'start' },
      '.grid2 > .bw_bccl_card, .grid3 > .bw_bccl_card': { height: 'auto' },

      // Carrier visualisation and data display — spab-specific, not something a
      // UI kit ships. Class names match what the playground emits.
      '.spab-view': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        fontSize: '13.5px', lineHeight: '2.05', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        padding: '14px 16px', borderRadius: '12px', maxHeight: '340px', overflow: 'auto' },
      '.slot': { display: 'inline-block', minWidth: '13px', height: '15px', lineHeight: '15px',
        textAlign: 'center', borderRadius: '3px', color: '#fff', fontSize: '10px',
        verticalAlign: 'middle', margin: '0 1px' },
      '.v0': { background: '#8b95a3' }, '.v1': { background: '#4a86c8' },
      '.v2': { background: '#3fa564' }, '.v3': { background: '#d98a3d' },
      '.pmark': { borderRadius: '3px', padding: '0 3px' },

      // Rows of badges / chips. Without a gap these render as one run-on string.
      '.metawrap': { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      '.chipwrap': { display: 'flex', flexWrap: 'wrap', gap: '8px' },

      '.intgrid': { display: 'grid', gridTemplateColumns: '250px 1fr', gap: '26px', alignItems: 'start' },
      '.code': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        fontSize: '13px', lineHeight: '1.65', padding: '14px 16px', borderRadius: '10px',
        overflowX: 'auto', whiteSpace: 'pre' },

      'table.t': { width: '100%', borderCollapse: 'collapse', fontSize: '14.5px', margin: '14px 0' },
      'table.t th, table.t td': { textAlign: 'left', padding: '10px 12px' },
      'table.t th': { fontWeight: '600', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.05em' },

      '.foot': { padding: '30px 0', marginTop: '48px', fontSize: '13.5px', opacity: '.72' },

      // Compact, left-justified hero: the old one spent most of the fold on padding
      // and centred type.
      '.hero .wrap': { padding: '46px 20px 48px' },
      '.hero h1': { fontSize: 'clamp(30px,3.5vw,46px)', lineHeight: '1.06',
        letterSpacing: '-.03em', margin: '0 0 14px', fontWeight: '800' },
      '.hero .lede': { fontSize: '17px', lineHeight: '1.6', margin: '0 0 24px', maxWidth: '60ch' },
      '.hero .btns': { display: 'flex', gap: '10px', flexWrap: 'wrap' },


      '.tryout': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        fontSize: '13px', lineHeight: '1.85', minHeight: '132px' },
      '.recovered': { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        fontSize: '15px', marginTop: '12px' },
      '.recovered b': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        fontSize: '16px' },

      '@media (max-width: 880px)': {
        '.hero .wrap': { padding: '34px 20px 36px' }
      },

      // Left-justify content that the components centre by default.
      '.bw_bccl_featureGrid .bw_feature': { textAlign: 'left' },
      '.bw_bccl_featureGrid .bw_feature_icon': { fontSize: '1.9rem !important', marginBottom: '.5rem' },
      '.bw_bccl_cta .bw_cta_content': { textAlign: 'left' },
      // The CTA nests its own centred .bw_container, which indents it ~150px past
      // every other section's left edge. Neutralise it so the page has one margin.
      '.bw_bccl_cta .bw_container': { maxWidth: 'none', paddingLeft: '0', paddingRight: '0' },

      '.install .wrap': { display: 'flex', alignItems: 'center', gap: '14px',
        flexWrap: 'wrap', padding: '14px 24px' },
      '.install .k': { textTransform: 'uppercase', letterSpacing: '.1em',
        fontSize: '11px', fontWeight: '700' },
      '.install code': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        fontSize: '13.5px', padding: '7px 12px', borderRadius: '8px' },

      '@media (max-width: 640px)': {
        '.site-head .wrap': { height: 'auto', flexWrap: 'wrap', padding: '10px 18px', gap: '2px' },
        '.brand': { width: '100%', marginBottom: '4px' },
        '.section': { padding: '34px 0' },
        '.grid2': { gridTemplateColumns: '1fr' },
        '.grid3': { gridTemplateColumns: '1fr' },
        '.intgrid': { gridTemplateColumns: '1fr' }
      }
    };
  }

  // Every rule here reads from `p`, so the same function generates both themes.
  function themedRules(p) {
    var bg = p.background || '#fff';
    return {
      'body': { background: bg, color: p.dark.base },

      '.site-head': { position: 'sticky', top: '0', zIndex: '20',
        background: 'color-mix(in srgb, ' + bg + ' 88%, transparent)',
        backdropFilter: 'saturate(180%) blur(12px)',
        borderBottom: '1px solid ' + p.light.border },
      '.brand': { color: p.dark.base },
      '.brand b': { color: p.primary.base },

      '.navlink': { color: p.dark.base },
      '.navlink:hover': { background: p.light.base },
      '.navlink.is-active': { color: p.primary.base, background: p.primary.light },

      '.icon-btn': { border: '1px solid ' + p.light.border, color: p.dark.base },
      '.icon-btn:hover': { background: p.light.base },

      '.eyebrow': { color: p.primary.base, opacity: '.9' },

      '.spab-view': { background: p.surface, border: '1px solid ' + p.light.border, color: p.dark.base },
      '.pmark': { background: p.secondary.base, color: '#fff' },
      '.code': { background: p.surface, border: '1px solid ' + p.light.border, color: p.dark.base },

      'table.t th, table.t td': { borderBottom: '1px solid ' + p.light.border },
      'table.t th': { color: p.dark.base, opacity: '.62' },

      '.foot': { borderTop: '1px solid ' + p.light.border },

      // Hero. Hand-built rather than makeHero(): that component centres its
      // content, and this is left-justified and deliberately short — the fold
      // belongs to the try-it panel below, not to a tall banner.
      '.hero': { background: 'linear-gradient(135deg,' + p.primary.active + ' 0%,' +
        p.primary.base + ' 58%,' + p.tertiary.base + ' 145%)', color: '#fff' },
      '.hero .eyebrow': { color: 'rgba(255,255,255,.72)' },
      '.hero h1': { color: '#fff' },
      '.hero .lede': { color: 'rgba(255,255,255,.86)' },


      // Install strip — a dark utility bar under the hero with the copyable command.
      '.install': { background: p.primary.darkText, color: 'rgba(255,255,255,.92)' },
      '.install code': { background: 'rgba(255,255,255,.10)', color: '#fff',
        border: '1px solid rgba(255,255,255,.18)' },
      '.install .k': { color: 'rgba(255,255,255,.55)' },

      // bitwrench maps `bw_text_muted` onto a warm palette entry, which renders
      // every feature description and CTA body in orange. Muted body copy should
      // read as quiet grey, not as an accent colour.
      '.bw_text_muted': { color: p.dark.base + ' !important', opacity: '.68' },
      // Same problem on the CTA body, which uses its own class.
      '.bw_cta_description': { color: p.dark.base + ' !important', opacity: '.72' }
    };
  }

  function injectSiteCSS(t) {
    bw.injectCSS(bw.css(staticRules()));
    bw.injectCSS(bw.css(themedRules(t.palette)));
    // The alternate palette is what `.bw_theme_alt` on <html> switches to.
    if (t.alternatePalette) {
      bw.injectCSS(bw.css(bw.scopeRulesUnder(themedRules(t.alternatePalette), '.bw_theme_alt')));
    }
  }

  // ── Chrome ────────────────────────────────────────────────────────────

  var SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var MARK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

  // Nav links are built with bw.link(), so navigation goes through the router
  // (preventDefault + router.navigate) while the href stays a real URL — middle
  // click and "copy link address" keep working.
  function navTree() {
    var links = SITE.nav.map(function (n) {
      var cls = 'navlink' + (n.path === state.path ? ' is-active' : '');
      return bw.link(n.path, n.text, { class: cls });
    });

    return { t: 'div', a: { class: 'wrap' }, c: [
      bw.link('/', [{ t: 'b', c: SITE.brand }, { t: 'span', c: SITE.tagline }], { class: 'brand' })
    ].concat(links).concat([
      { t: 'a', a: { class: 'icon-btn', href: SITE.github, target: '_blank', rel: 'noopener',
        title: 'Source on GitHub', 'aria-label': 'Source on GitHub' }, c: bw.raw(MARK) },
      { t: 'button', a: { class: 'icon-btn', type: 'button', onclick: toggleTheme,
        title: 'Toggle light / dark', 'aria-label': 'Toggle light or dark theme' },
        c: bw.raw(state.theme === 'dark' ? SUN : MOON) }
    ]) };
  }

  function paintNav() { bw.DOM('#site-nav', navTree()); }
  function paintFoot() { bw.DOM('#site-foot', footTree()); }

  function footTree() {
    return { t: 'div', a: { class: 'wrap' }, c: [
      { t: 'div', c: bw.raw(
        '<b>' + SITE.brand + '</b> — ' + SITE.tagline +
        ' · zero dependencies · BSD-2-Clause · port <b>1948</b> (Shannon, 1948)') },
      { t: 'div', a: { style: bw.s({ marginTop: '6px' }) }, c: [
        { t: 'a', a: { href: SITE.github, target: '_blank', rel: 'noopener' }, c: 'GitHub' },
        { t: 'span', c: ' · ' },
        bw.link('/libraries', 'Libraries'),
        { t: 'span', c: ' · ' },
        bw.link('/how', 'How it works')
      ] }
    ] };
  }

  // ── Public API ────────────────────────────────────────────────────────

  var API = {
    SITE: SITE,

    // Shared page-section helper so views compose the same way everywhere.
    section: function (opts) {
      return { t: 'section', a: { class: 'section' + (opts.tight ? ' section-tight' : '') },
        c: { t: 'div', a: { class: 'wrap' }, c: [
          opts.eyebrow ? { t: 'p', a: { class: 'eyebrow' }, c: opts.eyebrow } : null,
          opts.title ? { t: 'h2', a: { style: bw.s({ margin: '0 0 6px', letterSpacing: '-.02em' }) }, c: opts.title } : null,
          opts.lede ? { t: 'p', a: { class: 'lede' }, c: opts.lede } : null,
          { t: 'div', a: { style: bw.s({ marginTop: opts.title || opts.lede ? '26px' : '0' }) }, c: opts.content }
        ].filter(Boolean) } };
    },

    // Install strip, mirroring the bitwrench sites: the one thing a visitor who
    // likes what they see wants next. Sits directly under the hero.
    install: function () {
      return { t: 'div', a: { class: 'install' }, c: { t: 'div', a: { class: 'wrap' }, c: [
        { t: 'span', a: { class: 'k' }, c: 'Install' },
        { t: 'code', c: 'npm i ' + (SITE.npm || '@deftio/spab') },
        { t: 'span', a: { class: 'k' }, c: 'or CDN' },
        { t: 'code', c: '<script src="…/spab.js"><\/script>' },
        { t: 'span', a: { style: bw.s({ marginLeft: 'auto', display: 'flex', gap: '10px' }) }, c: [
          bw.makeButton({ text: 'Libraries →', variant: 'light', size: 'sm',
            onclick: function () { bw.navigate('/libraries'); } })
        ] }
      ] } };
    },

    notFound: function () {
      return API.section({
        eyebrow: '404',
        title: 'No such page',
        lede: 'That route does not exist.',
        content: bw.makeButton({ text: 'Back to home', variant: 'primary',
          onclick: function () { bw.navigate('/'); } })
      });
    },

    // Boot the chrome and the router. The theme is already live (see below),
    // so views may read SPABSite.palette at definition time. Returns the router.
    start: function (config) {
      bw.DOM('#app', { t: 'div', a: { class: 'site' }, c: [
        { t: 'header', a: { class: 'site-head', id: 'site-nav' } },
        { t: 'main', a: { class: 'site-main', id: 'view' } },
        { t: 'footer', a: { class: 'foot', id: 'site-foot' } }
      ] });

      // The nav owns its own active state by listening for route changes,
      // rather than the router repainting chrome it does not own.
      bw.sub('bw:route', function (e) {
        state.path = (e && e.path) || '/';
        paintNav();
        try { root.scrollTo(0, 0); } catch (err) { /* non-browser host */ }
      });

      // The router MUST exist before any chrome is painted. bw.link() emits a
      // hash href ("#/how") only while a router is active, and a plain path
      // ("/how") otherwise — and this site is served from a subpath
      // (…github.io/spab/pages/), where "/how" resolves to the domain root and
      // breaks middle-click, copy-link, and no-JS navigation. Painting the nav
      // first would bake those broken hrefs into the first render.
      var router = bw.router({
        target: '#view',
        mode: 'hash',
        routes: config.routes
      });

      paintNav();
      paintFoot();

      return router;
    }
  };

  // ── Init ──────────────────────────────────────────────────────────────
  //
  // The theme is generated and injected as soon as this file loads, not inside
  // start(). Views are plain functions that read palette values while building
  // their trees, and they are defined before start() runs — so the palette has
  // to exist first. This also means the page paints with its final colors
  // rather than flashing an unstyled frame.
  // loadStyles() already injects the structural (theme-independent) component CSS
  // itself, so it is not called here. loadReset() is separate and is not implied
  // by it — box-sizing, base typography, reduced-motion — so it is called first.
  // Idempotent.
  bw.loadReset();

  var theme = bw.loadStyles(SITE.theme);
  injectSiteCSS(theme);

  state.theme = preferredTheme();
  applyTheme(state.theme);

  API.theme = theme;
  API.palette = theme.palette;
  API.layout = theme.layout;

  root.SPABSite = API;
})(typeof window !== 'undefined' ? window : this);
