# WP Blog Notes

Let readers highlight text on a blog post and leave a note about it.

Notes are real WordPress comments. On wide screens they show up as little cards in the right margin, level with the passage they are about. On small screens, or whenever there is no room in the margin, they show up at the bottom with the other comments, with the quoted passage attached so you know what they are replying to. Regular, general comments keep working exactly as before.

## How it works

- Select text in a post and an **Add note** button appears.
- **Wide screens:** a card opens in the margin next to your selection. Type, post, done.
- **Small screens:** the quote is attached to the normal comment form at the bottom of the post.
- Highlighted passages are shown to everyone. Hover a highlight or a card to see its match, click a highlight to open the full note.
- Clicking the quote on a comment in the list scrolls up to the passage.

Notes go through the same validation, flood control, spam filters (Akismet etc.) and moderation settings as any other comment. Nothing extra to configure.

## Install

Copy this folder to `wp-content/plugins/wp-blog-notes` and activate it. It is active on single posts that have comments turned on (existing notes still display if comments are later closed).

## Storage

A note is a comment plus three pieces of comment meta: `wpbn_quote`, `wpbn_prefix` and `wpbn_suffix`. The prefix and suffix are a few words of surrounding text, used to find the right spot when the same phrase appears more than once. If a post is edited and the quoted text is gone, the note stays in the comment list and just loses its highlight.

## Customizing

Filters:

| Filter | Default | Purpose |
| --- | --- | --- |
| `wpbn_post_types` | `['post']` | Post types that get notes |
| `wpbn_content_selector` | `.entry-content, .wp-block-post-content, .post-content, .post__content` | CSS selector for the post body readers can highlight |
| `wpbn_form_selector` | `#commentform, form.comment-form` | CSS selector for the comment form |

Colors, radius and so on are CSS custom properties (`--wpbn-hl`, `--wpbn-card-bg`, ...) at the top of `assets/blog-notes.css`.

## Known limits

- The margin layout needs about 220px of free space to the right of the post content. Narrower than that, notes fall back to the bottom layout.
- Selections are limited to 600 characters.
- Replies to a note go in the normal comment list.

## License

GPL-2.0-or-later
