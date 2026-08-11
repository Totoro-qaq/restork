# Restork launch kit

These are drafts for the maintainer to edit before publishing. Replace bracketed release and demo
links only after a signed Alpha exists. Never attach private screenshots or a real Vault.

| Community | Draft | Language |
|---|---|---|
| Hacker News | [hacker-news.md](hacker-news.md) | English |
| r/LocalLLaMA | [localllama.md](localllama.md) | English |
| Obsidian community | [obsidian.md](obsidian.md) | English |
| V2EX | [v2ex.md](v2ex.md) | 简体中文 |
| 知乎 | [zhihu.md](zhihu.md) | 简体中文 |
| 掘金 | [juejin.md](juejin.md) | 简体中文 |
| 技术交流微信群 | [wechat.md](wechat.md) | 简体中文 |

Before publishing:

1. merge the reviewed release commit;
2. finish signing and test every installer on a clean machine;
3. replace `[SIGNED RELEASE URL]` and `[60-SECOND DEMO URL]`;
4. verify the linked README language and screenshots;
5. stay available for technical questions and publish failures as openly as successes.

## Social previews

The project site publishes language-matched 1280 x 640 Open Graph and X/Twitter images:

- English: [social-preview.png](../../assets/readme/social-preview.png)
- Simplified Chinese: [social-preview.zh-CN.png](../../assets/readme/social-preview.zh-CN.png)

Both images are generated from the public static site and contain synthetic content only. GitHub
does not expose a supported API for the repository-level Social preview setting. A repository owner
must upload the English image once in **Settings -> General -> Social preview -> Edit**. Keep this
owner-only UI action separate from launch-post publishing and never substitute a private screenshot.
