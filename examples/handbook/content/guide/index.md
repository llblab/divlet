---
title: The guide
description: How the shared template and content tree fit together.
order: 10
---

A divlet site starts with an ordinary document. Its stable nodes become slots for a page title, a navigation tree and Markdown content.

![A shared template branching into three pages](./assets/shared-layout.svg)

## The shared shell

The template controls the complete visual frame: the header above, the navigation beside you, and the type on this page. Its responsive CSS adapts the same structure to a narrow browser.

You can patch the template through `divlet_patch`. Every page uses the next accepted version without copying the shared layout into another source file.

## Independent chapters

Markdown remains a normal file. That makes it practical to give separate chapters to separate agents while keeping one layout owner.

1. Create a Markdown file in the content directory.
2. Give it a clear title.
3. Connect it with a relative Markdown link.
4. Check the live route in the browser.

Continue to [first steps](./start.md), or return [home](../index.md).
