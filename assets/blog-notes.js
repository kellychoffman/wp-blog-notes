/**
 * WP Blog Notes
 *
 * - Highlights passages that have notes attached.
 * - Shows each note as a card in the right margin, level with its passage.
 * - Lets readers select text and add a note.
 * - On narrow screens the margin is hidden and notes behave like normal
 *   comments at the bottom (with the quoted passage attached).
 */
(function () {
	'use strict';

	var cfg = window.WPBN;
	if (!cfg) { return; }

	var i18n = cfg.i18n || {};
	var CARD_W = 240;   // preferred margin card width
	var MIN_W = 200;    // below this, fall back to the bottom layout
	var GAP = 20;       // space between content and margin
	var STACK_GAP = 10; // space between stacked cards
	var MAX_QUOTE = 600;

	var content, container, addBtn;
	var entries = [];       // { id, note, card, marks, draft }
	var marginMode = false;
	var pending = null;     // selection captured when the Add note button was shown
	var draft = null;       // open margin draft entry
	var selTimer = null;
	var layoutQueued = false;

	/* ------------------------------------------------------------ helpers */

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) { e.className = cls; }
		if (text != null) { e.textContent = text; }
		return e;
	}

	function norm(s) { return String(s).replace(/\s+/g, ' '); }

	function store(key, val) {
		try {
			if (val === undefined) { return JSON.parse(window.localStorage.getItem(key)); }
			window.localStorage.setItem(key, JSON.stringify(val));
		} catch (e) { /* storage unavailable */ }
		return null;
	}

	/**
	 * Flatten the post content into one whitespace-collapsed string and keep a
	 * map from each character back to its text node and offset.
	 */
	function buildFlat() {
		var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
			acceptNode: function (n) {
				var p = n.parentNode;
				if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(p.nodeName)) { return NodeFilter.FILTER_REJECT; }
				return NodeFilter.FILTER_ACCEPT;
			}
		});
		var text = '', nodes = [], offs = [], prevSpace = false, n, t, i, ch;
		while ((n = walker.nextNode())) {
			t = n.nodeValue;
			for (i = 0; i < t.length; i++) {
				ch = t.charAt(i);
				if (/\s/.test(ch)) {
					if (prevSpace) { continue; }
					ch = ' ';
					prevSpace = true;
				} else {
					prevSpace = false;
				}
				text += ch;
				nodes.push(n);
				offs.push(i);
			}
		}
		return { text: text, nodes: nodes, offs: offs };
	}

	/** Find where a note's quote lives in the content; returns [start, end] or null. */
	function locate(flat, note) {
		var q = norm(note.quote).trim();
		if (!q) { return null; }

		var best = -1, bestScore = -1, from = 0, i, score, pre, suf;
		while ((i = flat.text.indexOf(q, from)) > -1) {
			score = 0;
			pre = note.prefix || '';
			suf = note.suffix || '';
			if (pre && flat.text.slice(Math.max(0, i - pre.length), i) === pre) { score++; }
			if (suf && flat.text.substr(i + q.length, suf.length) === suf) { score++; }
			if (score > bestScore) { best = i; bestScore = score; }
			from = i + 1;
		}
		return best < 0 ? null : [best, best + q.length];
	}

	/** Wrap flat range [s, e) in <mark> elements. Returns the marks. */
	function wrap(flat, s, e, id, draftMark) {
		var segs = [], cur = null, k, node, off, marks = [];

		for (k = s; k < e; k++) {
			node = flat.nodes[k];
			off = flat.offs[k];
			if (!cur || cur.node !== node) {
				cur = { node: node, start: off, end: off + 1 };
				segs.push(cur);
			} else {
				cur.end = off + 1;
			}
		}

		segs.forEach(function (seg) {
			var mid, mark;
			if (!/\S/.test(seg.node.nodeValue.slice(seg.start, seg.end))) { return; }
			mid = seg.start > 0 ? seg.node.splitText(seg.start) : seg.node;
			if (seg.end - seg.start < mid.nodeValue.length) { mid.splitText(seg.end - seg.start); }
			mark = document.createElement('mark');
			mark.className = 'wpbn-hl' + (draftMark ? ' wpbn-hl-draft' : '');
			mark.setAttribute('data-wpbn-id', id);
			mid.parentNode.insertBefore(mark, mid);
			mark.appendChild(mid);
			marks.push(mark);
		});

		return marks;
	}

	function unwrap(marks) {
		marks.forEach(function (m) {
			var p = m.parentNode;
			if (!p) { return; }
			while (m.firstChild) { p.insertBefore(m.firstChild, m); }
			p.removeChild(m);
			p.normalize();
		});
	}

	function highlight(note, id, draftMark) {
		var flat = buildFlat();
		var r = locate(flat, note);
		return r ? wrap(flat, r[0], r[1], id, draftMark) : [];
	}

	/* -------------------------------------------------------------- cards */

	function buildCard(n) {
		var card = el('article', 'wpbn-card');
		card.setAttribute('data-wpbn-id', n.id);

		var head = el('header', 'wpbn-card-head');
		if (n.avatar) {
			var img = el('img', 'wpbn-avatar');
			img.src = n.avatar;
			img.alt = '';
			img.width = img.height = 24;
			head.appendChild(img);
		}
		head.appendChild(el('span', 'wpbn-author', n.author));
		head.appendChild(el('span', 'wpbn-date', n.date));
		card.appendChild(head);

		var body = el('div', 'wpbn-card-body');
		body.innerHTML = n.content; // already filtered by WordPress
		card.appendChild(body);

		var foot = el('footer', 'wpbn-card-foot');
		var a = el('a', 'wpbn-reply', n.replies ? (n.replies === 1 ? i18n.reply1 : n.replies + ' ' + i18n.replies) : i18n.reply);
		a.href = n.link;
		foot.appendChild(a);
		card.appendChild(foot);

		return card;
	}

	function addNote(n) {
		var marks = highlight(n, n.id, false);
		var card = buildCard(n);
		card.hidden = !marks.length; // orphaned notes (passage was edited) stay in the comment list only
		container.appendChild(card);
		entries.push({ id: n.id, note: n, card: card, marks: marks });
	}

	function find(id) {
		for (var i = 0; i < entries.length; i++) {
			if (String(entries[i].id) === String(id)) { return entries[i]; }
		}
		return null;
	}

	/* ------------------------------------------------------------- layout */

	/**
	 * Right edge of the reading column. Block themes make the content wrapper
	 * full width and constrain its children, so measure the text blocks instead.
	 */
	function columnRect() {
		var r = content.getBoundingClientRect();
		var right = -Infinity, kids = content.querySelectorAll(':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > ul, :scope > ol, :scope > blockquote, :scope > pre');
		for (var i = 0; i < kids.length; i++) {
			right = Math.max(right, kids[i].getBoundingClientRect().right);
		}
		return { right: right > -Infinity ? Math.min(right, r.right) : r.right, top: r.top };
	}

	function updateMode() {
		var r = columnRect();
		var avail = document.documentElement.clientWidth - r.right - GAP - 12;
		var was = marginMode;
		marginMode = avail >= MIN_W;
		container.style.display = marginMode ? 'block' : 'none';
		document.documentElement.classList.toggle('wpbn-margin-on', marginMode);
		if (was && !marginMode && draft) { closeDraft(); }
	}

	function layout() {
		layoutQueued = false;
		updateMode();
		if (!marginMode) { return; }

		var r = columnRect();
		var avail = document.documentElement.clientWidth - r.right - GAP - 12;
		var top = r.top + window.pageYOffset;

		container.style.left = (r.right + window.pageXOffset + GAP) + 'px';
		container.style.top = top + 'px';
		container.style.width = Math.min(CARD_W, avail) + 'px';

		var list = entries.filter(function (e) { return e.marks.length && !e.card.hidden; });
		list.forEach(function (e) {
			e.y = e.marks[0].getBoundingClientRect().top - r.top;
		});
		list.sort(function (a, b) { return a.y - b.y; });

		var bottom = -Infinity;
		list.forEach(function (e) {
			var y = Math.max(e.y, bottom + STACK_GAP);
			e.card.style.top = y + 'px';
			bottom = y + e.card.offsetHeight;
		});
	}

	function queueLayout() {
		if (layoutQueued) { return; }
		layoutQueued = true;
		window.requestAnimationFrame(layout);
	}

	/* ------------------------------------------------- hover / activation */

	function setHot(id, on) {
		var e = find(id);
		if (!e) { return; }
		e.card.classList.toggle('wpbn-hot', on);
		e.marks.forEach(function (m) { m.classList.toggle('wpbn-hot', on); });
	}

	function flash(marks) {
		marks.forEach(function (m) { m.classList.add('wpbn-flash'); });
		window.setTimeout(function () {
			marks.forEach(function (m) { m.classList.remove('wpbn-flash'); });
		}, 1600);
	}

	function onClick(ev) {
		var t = ev.target;
		if (!t || !t.closest) { return; }

		var mark = t.closest('mark.wpbn-hl[data-wpbn-id]');
		if (mark && !mark.classList.contains('wpbn-hl-draft')) {
			var e = find(mark.getAttribute('data-wpbn-id'));
			if (!e) { return; }
			if (marginMode) {
				toggleActive(e);
			} else {
				var target = document.getElementById('comment-' + e.id);
				if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
			}
			return;
		}

		var card = t.closest('.wpbn-card[data-wpbn-id]');
		if (card && !t.closest('a')) {
			toggleActive(find(card.getAttribute('data-wpbn-id')));
			return;
		}

		var quote = t.closest('.wpbn-quote[data-wpbn-comment]');
		if (quote) {
			var q = find(quote.getAttribute('data-wpbn-comment'));
			if (q && q.marks.length) {
				q.marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
				flash(q.marks);
			}
		}
	}

	function toggleActive(e) {
		if (!e) { return; }
		var on = !e.card.classList.contains('wpbn-active');
		entries.forEach(function (x) { x.card.classList.remove('wpbn-active'); });
		e.card.classList.toggle('wpbn-active', on);
		if (on) { flash(e.marks); }
		queueLayout();
	}

	function onHover(ev, on) {
		var t = ev.target;
		if (!t || !t.closest) { return; }
		var el1 = t.closest('mark.wpbn-hl[data-wpbn-id], .wpbn-card[data-wpbn-id]');
		if (el1 && !el1.classList.contains('wpbn-hl-draft')) { setHot(el1.getAttribute('data-wpbn-id'), on); }
	}

	/* ------------------------------------------------- selecting and notes */

	function showBtn(range) {
		var rects = range.getClientRects();
		var last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
		var sx = window.pageXOffset, sy = window.pageYOffset;

		addBtn.hidden = false;
		var w = addBtn.offsetWidth, h = addBtn.offsetHeight;
		var left = last.right + sx - w / 2;
		left = Math.max(sx + 8, Math.min(left, sx + document.documentElement.clientWidth - w - 8));
		var top = coarse ? last.bottom + sy + 12 : last.top + sy - h - 10;
		if (top < sy + 8) { top = last.bottom + sy + 10; }

		addBtn.style.left = left + 'px';
		addBtn.style.top = top + 'px';
	}

	function hideBtn() {
		if (addBtn) { addBtn.hidden = true; }
	}

	function checkSelection() {
		var s = window.getSelection();
		if (!cfg.canNote || !s || !s.rangeCount || s.isCollapsed) { pending = null; hideBtn(); return; }

		var r = s.getRangeAt(0);
		if (!content.contains(r.commonAncestorContainer)) { pending = null; hideBtn(); return; }

		var q = norm(r.toString()).trim();
		if (q.length < 3 || q.length > MAX_QUOTE) { pending = null; hideBtn(); return; }

		// Work out where the selection starts so repeated phrases can be told apart.
		var flat = buildFlat();
		var pre = document.createRange();
		pre.selectNodeContents(content);
		pre.setEnd(r.startContainer, r.startOffset);
		var guess = norm(pre.toString()).length;
		var idx = flat.text.indexOf(q, Math.max(0, guess - 2));
		if (idx < 0) { idx = flat.text.indexOf(q); }
		if (idx < 0) { pending = null; hideBtn(); return; }

		pending = {
			quote: q,
			prefix: flat.text.slice(Math.max(0, idx - 32), idx),
			suffix: flat.text.substr(idx + q.length, 32)
		};
		showBtn(r);
	}

	function onSelectionChange() {
		window.clearTimeout(selTimer);
		selTimer = window.setTimeout(checkSelection, 150);
	}

	function startNote() {
		var sel = pending;
		hideBtn();
		if (!sel) { return; }

		if (marginMode) {
			var s = window.getSelection();
			if (s) { s.removeAllRanges(); }
			openDraft(sel);
		} else {
			attachToForm(sel);
		}
	}

	/* ---- margin draft card (desktop) */

	function openDraft(sel) {
		closeDraft();

		var marks = highlight(sel, 'draft', true);
		if (!marks.length) { attachToForm(sel); return; }

		var card = el('form', 'wpbn-card wpbn-draft');
		card.noValidate = true;

		var ta = el('textarea', 'wpbn-field wpbn-textarea');
		ta.placeholder = i18n.placeholder;
		ta.rows = 3;
		ta.required = true;
		card.appendChild(ta);

		var name, email;
		if (!cfg.loggedIn) {
			var saved = store('wpbn_identity') || {};
			name = el('input', 'wpbn-field');
			name.type = 'text';
			name.placeholder = i18n.name + (cfg.requireIdentity ? ' *' : '');
			name.autocomplete = 'name';
			name.value = saved.name || '';
			email = el('input', 'wpbn-field');
			email.type = 'email';
			email.placeholder = i18n.email + (cfg.requireIdentity ? ' *' : '');
			email.autocomplete = 'email';
			email.value = saved.email || '';
			card.appendChild(name);
			card.appendChild(email);
		}

		var err = el('p', 'wpbn-error');
		err.hidden = true;
		card.appendChild(err);

		var row = el('div', 'wpbn-actions');
		var cancel = el('button', 'wpbn-btn-secondary', i18n.cancel);
		cancel.type = 'button';
		var submit = el('button', 'wpbn-btn-primary', i18n.post);
		submit.type = 'submit';
		row.appendChild(cancel);
		row.appendChild(submit);
		card.appendChild(row);

		container.appendChild(card);
		draft = { id: 'draft', card: card, marks: marks };
		entries.push(draft);
		layout();
		ta.focus({ preventScroll: true });

		cancel.addEventListener('click', closeDraft);
		card.addEventListener('keydown', function (ev) {
			if (ev.key === 'Escape') { closeDraft(); }
			if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { card.requestSubmit ? card.requestSubmit() : submit.click(); }
		});
		ta.addEventListener('input', queueLayout);

		card.addEventListener('submit', function (ev) {
			ev.preventDefault();
			err.hidden = true;
			if (!ta.value.trim()) { ta.focus(); return; }

			var payload = {
				post_id: cfg.postId,
				content: ta.value,
				quote: sel.quote,
				prefix: sel.prefix,
				suffix: sel.suffix,
				author: name ? name.value : '',
				email: email ? email.value : ''
			};

			submit.disabled = true;
			submit.textContent = i18n.posting;

			window.fetch(cfg.restUrl, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': cfg.nonce },
				body: JSON.stringify(payload)
			}).then(function (res) {
				return res.json().then(function (json) { return { ok: res.ok, json: json }; });
			}).then(function (out) {
				if (!out.ok) { throw new Error(out.json && out.json.message ? out.json.message : i18n.error); }

				if (name) { store('wpbn_identity', { name: name.value, email: email ? email.value : '' }); }
				closeDraft();

				if (out.json.status === 'approved' && out.json.note) {
					addNote(out.json.note);
					layout();
				} else {
					showNotice(i18n.moderation, sel);
				}
			}).catch(function (e) {
				err.textContent = e.message || i18n.error;
				err.hidden = false;
				submit.disabled = false;
				submit.textContent = i18n.post;
				queueLayout();
			});
		});
	}

	function closeDraft() {
		if (!draft) { return; }
		unwrap(draft.marks);
		if (draft.card.parentNode) { draft.card.parentNode.removeChild(draft.card); }
		entries = entries.filter(function (e) { return e !== draft; });
		draft = null;
		queueLayout();
	}

	/** Brief confirmation next to the passage when the note is held for moderation. */
	function showNotice(text, sel) {
		var marks = highlight(sel, 'notice', true);
		var card = el('div', 'wpbn-card wpbn-notice', text);
		container.appendChild(card);
		var e = { id: 'notice', card: card, marks: marks };
		entries.push(e);
		layout();
		window.setTimeout(function () {
			unwrap(marks);
			if (card.parentNode) { card.parentNode.removeChild(card); }
			entries = entries.filter(function (x) { return x !== e; });
			queueLayout();
		}, 6000);
	}

	/* ---- regular comment form (small screens) */

	function attachToForm(sel) {
		var form = document.querySelector(cfg.formSelector);
		if (!form) { return; }

		var marks = highlight(sel, 'form', true);

		['quote', 'prefix', 'suffix'].forEach(function (k) {
			var input = form.querySelector('input[name="wpbn_' + k + '"]');
			if (!input) {
				input = document.createElement('input');
				input.type = 'hidden';
				input.name = 'wpbn_' + k;
				form.appendChild(input);
			}
			input.value = sel[k];
		});

		var old = form.querySelector('.wpbn-chip');
		if (old) { old.parentNode.removeChild(old); }
		document.querySelectorAll('mark.wpbn-hl-draft[data-wpbn-id="form"]').forEach(function (m) {
			if (marks.indexOf(m) < 0) { unwrap([m]); }
		});

		var chip = el('div', 'wpbn-chip');
		var label = el('span', 'wpbn-chip-label', i18n.commenting);
		var text = el('blockquote', 'wpbn-chip-quote', '“' + sel.quote + '”');
		var rm = el('button', 'wpbn-chip-remove', '×');
		rm.type = 'button';
		rm.setAttribute('aria-label', i18n.remove);
		rm.addEventListener('click', function () {
			['quote', 'prefix', 'suffix'].forEach(function (k) {
				var i = form.querySelector('input[name="wpbn_' + k + '"]');
				if (i) { i.parentNode.removeChild(i); }
			});
			chip.parentNode.removeChild(chip);
			unwrap(marks);
		});
		chip.appendChild(label);
		chip.appendChild(text);
		chip.appendChild(rm);

		var ta = form.querySelector('textarea[name="comment"]');
		var anchor = ta ? (ta.closest('p, .comment-form-comment, .wp-block-post-comments-form > *') || ta) : null;
		if (anchor && anchor.parentNode) {
			anchor.parentNode.insertBefore(chip, anchor);
		} else {
			form.insertBefore(chip, form.firstChild);
		}

		var s = window.getSelection();
		if (s) { s.removeAllRanges(); }

		form.scrollIntoView({ behavior: 'smooth', block: 'center' });
		if (ta) { ta.focus({ preventScroll: true }); }
	}

	/* --------------------------------------------------------------- init */

	function init() {
		var found = document.querySelectorAll(cfg.contentSelector);
		content = found.length ? found[0] : null;
		if (!content) { return; }

		container = el('div', 'wpbn-margin wpbn-ui');
		document.body.appendChild(container);

		(cfg.notes || []).forEach(addNote);

		if (cfg.canNote) {
			addBtn = el('button', 'wpbn-add wpbn-ui');
			addBtn.type = 'button';
			addBtn.hidden = true;
			addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
			addBtn.appendChild(el('span', null, i18n.addNote));
			// Keep the text selected while the button is pressed.
			addBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
			addBtn.addEventListener('touchstart', function (e) { e.preventDefault(); startNote(); }, { passive: false });
			addBtn.addEventListener('click', startNote);
			document.body.appendChild(addBtn);

			document.addEventListener('selectionchange', onSelectionChange);
		}

		document.addEventListener('click', onClick);
		document.addEventListener('mouseover', function (e) { onHover(e, true); });
		document.addEventListener('mouseout', function (e) { onHover(e, false); });
		window.addEventListener('resize', queueLayout);
		window.addEventListener('load', queueLayout);

		if (window.ResizeObserver) { new ResizeObserver(queueLayout).observe(content); }
		if (document.fonts && document.fonts.ready) { document.fonts.ready.then(queueLayout); }

		layout();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
