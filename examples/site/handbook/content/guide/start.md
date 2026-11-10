---
title: First steps
description: Create a page, connect its route and iterate.
order: 20
---

You are reading `content/guide/start.md` through the shared divlet template. Its route comes directly from that source path.

## Your first route

Create `content/notes.md` with a small introduction:

```markdown
---
title: Notes
order: 30
---

Small observations, collected over time.
```

The next accepted scan adds `/notes/` and updates the navigation. An open route reloads automatically after the new site snapshot is ready.

## Make one design change

Read the `docs-template` document, then patch its CSS or stable nodes. The title, navigation and content slots keep their template styles while receiving each page's content.

## Keep the loop small

- Edit one source with a clear purpose.
- Check the route at a narrow and a wide viewport.
- Resolve diagnostics before making another structural change.

Read [the guide](./index.md#the-shared-shell) again, or go [home](../index.md).
