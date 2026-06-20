# tabby-ai

An AI assistant plugin for the [Tabby](https://github.com/Eugeny/tabby) terminal.

`tabby-ai` brings AI-assisted workflows into Tabby. This is the initial scaffold
(issue #1): a discoverable, loadable Tabby plugin that registers a default
Angular `NgModule`. AI features are added in follow-up issues.

## Status

Early scaffold. The plugin loads cleanly and logs `tabby-ai loaded` to the
console on startup. No user-facing AI features are wired up yet.

## Install

### From the Plugin Manager (recommended)

Once published to npm with the `tabby-plugin` keyword, `tabby-ai` will appear in
Tabby under **Settings → Plugins**. Search for `tabby-ai` and click install.

### Local development

Build the plugin, then point Tabby at the checkout:

```bash
npm install
npm run build              # one-off build → dist/index.js
npm run watch              # rebuild on change
TABBY_PLUGINS=$(pwd) tabby --debug
```

Tabby loads any module whose `package.json` `keywords` array contains
`tabby-plugin`.

## Roadmap

Planned AI features (provider integrations, inline command suggestions, output
summarization, etc.) are tracked on the issue tracker:

https://github.com/vaibhavarora27/tabby-ai/issues

## License

[MIT](./LICENSE) © 2026 Vaibhav Arora
