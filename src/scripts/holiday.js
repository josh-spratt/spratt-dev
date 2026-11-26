// Holiday decorations: the lights, the snow and the switch. HolidayBoot loads
// this from the head only between 20 November and 25 December, and has already
// set html[data-season] and, unless the visitor turned it off, data-holiday="on".
// holiday.css styles everything built here.
(function () {
  var KEY = "holiday"; // matches HOLIDAY_KEY in src/lib/holiday.ts
  var root = document.documentElement;
  if (!root.dataset.season) return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorate);
  else decorate();

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (html) node.innerHTML = html;
    return node;
  }

  function decorate() {
    var lights = el("div", { class: "lights", "aria-hidden": "true" }, new Array(65).join("<i></i>"));
    var canvas = el("canvas", { class: "snow", "data-snow": "", "aria-hidden": "true" });
    var toggle = el(
      "button",
      { class: "holiday-toggle", type: "button", "data-holiday-toggle": "", "aria-pressed": "false" },
      '<span aria-hidden="true">❄</span> Holiday mode <span class="track" aria-hidden="true"></span>',
    );
    document.body.prepend(lights);
    document.body.append(canvas, toggle);

    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    var chrome = meta && meta.content;
    var still = matchMedia("(prefers-reduced-motion: reduce)");
    var snow = makeSnow(canvas);

    function apply(on) {
      if (on) root.dataset.holiday = "on";
      else delete root.dataset.holiday;
      toggle.setAttribute("aria-pressed", String(on));
      if (meta) meta.content = on ? "#3d9b4a" : chrome;
      if (on && !still.matches) snow.start();
      else snow.stop();
    }

    toggle.addEventListener("click", function () {
      var on = root.dataset.holiday !== "on";
      try {
        if (on) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, "off");
      } catch (e) {}
      apply(on);
    });
    still.addEventListener("change", function () {
      apply(root.dataset.holiday === "on");
    });
    apply(root.dataset.holiday === "on");
  }

  // Outlined flakes, like the bricks, that fall, sway, and pile up on the top
  // edge of each card and key and along the bottom of the screen.
  function makeSnow(canvas) {
    var ctx = canvas.getContext("2d");
    var COL = 4; // px of width per pile column
    var CARD_CAP = 9; // deepest snow on a card, in px
    var SURFACES = ".rows a, .post-list li, .post-nav a[data-older], .post-nav a[data-newer], .navs a, .key, .holiday-toggle";
    var INK = "#15151a";
    var W = 0, H = 0, flakes = [], ground = null, groundCap = 0, surfaces = [], piles = new Map(), raf = 0, last = 0;

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = innerWidth;
      H = innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      groundCap = Math.min(30, H * 0.04);
      var old = ground;
      ground = new Float32Array(Math.ceil(W / COL) + 1);
      if (old) ground.set(old.length > ground.length ? old.subarray(0, ground.length) : old);
      var want = Math.min(280, Math.round((W * H) / 4000));
      while (flakes.length < want) flakes.push(flake(true));
      flakes.length = want;
      surfaces = Array.prototype.slice.call(document.querySelectorAll(SURFACES));
    }

    function flake(anywhere) {
      var r = 1.4 + Math.random() * Math.random() * 3.6;
      return {
        x: Math.random() * W,
        y: anywhere ? Math.random() * H : -8 - Math.random() * 60,
        r: r,
        vy: 16 + r * 9 + Math.random() * 10,
        phase: Math.random() * 6.283,
        sway: 0.5 + Math.random() * 1.1,
        drift: 6 + Math.random() * 14,
      };
    }

    function groundCapAt(j) {
      return groundCap * (0.75 + 0.25 * Math.sin(j * 0.045) * Math.sin(j * 0.013 + 1));
    }

    // Rounded card corners hold less snow than the middle of the top edge.
    function cardCapAt(n) {
      return function (j) {
        var edge = Math.min(j + 0.5, n - j - 0.5) * COL;
        return CARD_CAP * Math.min(1, edge / 16);
      };
    }

    function deposit(h, i, r, cap) {
      var spread = Math.max(1, Math.round((r * 1.6) / COL));
      for (var k = -spread; k <= spread; k++) {
        var j = i + k;
        if (j < 0 || j >= h.length) continue;
        h[j] = Math.min(cap(j), h[j] + r * 1.6 * (1 - Math.abs(k) / (spread + 1)));
      }
      // Let steep steps slide into their neighbours, so piles round off.
      for (var pass = 0; pass < 2; pass++) {
        for (j = Math.max(0, i - spread - 3); j < Math.min(h.length - 1, i + spread + 3); j++) {
          var d = h[j] - h[j + 1];
          if (Math.abs(d) <= 1.6) continue;
          var m = (d - Math.sign(d) * 1.6) / 2;
          h[j] -= m;
          h[j + 1] = Math.min(cap(j + 1), h[j + 1] + m);
        }
      }
    }

    function pileOf(el, n) {
      var h = piles.get(el);
      if (!h || h.length !== n) {
        h = new Float32Array(n);
        piles.set(el, h);
      }
      return h;
    }

    function drawPile(h, left, base) {
      ctx.beginPath();
      ctx.moveTo(left, base);
      ctx.lineTo(left, base - h[0]);
      for (var j = 1; j < h.length; j++) {
        var x0 = left + (j - 0.5) * COL;
        ctx.quadraticCurveTo(x0, base - h[j - 1], x0 + COL / 2, base - (h[j - 1] + h[j]) / 2);
      }
      ctx.lineTo(left + h.length * COL, base - h[h.length - 1]);
      ctx.lineTo(left + h.length * COL, base);
      ctx.fill();
      ctx.stroke();
    }

    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Where each card's top edge is right now (it moves on scroll and hover).
      var rects = [];
      for (var s = 0; s < surfaces.length; s++) {
        var b = surfaces[s].getBoundingClientRect();
        if (b.bottom < 0 || b.top > H || b.width < COL * 4) continue;
        var n = Math.floor(b.width / COL);
        rects.push({ left: b.left, top: b.top, right: b.left + n * COL, h: pileOf(surfaces[s], n), cap: cardCapAt(n) });
      }

      for (var f = 0; f < flakes.length; f++) {
        var p = flakes[f];
        var prevY = p.y;
        p.phase += p.sway * dt;
        p.y += p.vy * dt;
        p.x += Math.sin(p.phase) * p.drift * dt;
        if (p.x < -10) p.x += W + 20;
        else if (p.x > W + 10) p.x -= W + 20;

        var landed = false;
        for (var k = 0; k < rects.length && !landed; k++) {
          var c = rects[k];
          if (p.x < c.left || p.x >= c.right) continue;
          var j = Math.floor((p.x - c.left) / COL);
          var top = c.top - c.h[j];
          if (prevY <= top && p.y >= top) {
            // Some flakes miss the edge and keep falling past the card.
            if (Math.random() < 0.65) {
              deposit(c.h, j, p.r, c.cap);
              landed = true;
            }
          }
        }
        if (!landed && p.x >= 0 && p.x < W) {
          var g = Math.floor(p.x / COL);
          if (p.y >= H - ground[g]) {
            deposit(ground, g, p.r, groundCapAt);
            landed = true;
          }
        }
        if (landed || p.y > H + 10) flakes[f] = flake(false);
      }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = INK;
      ctx.lineJoin = "round";
      ctx.lineWidth = 2;
      for (k = 0; k < rects.length; k++) drawPile(rects[k].h, rects[k].left, rects[k].top + 1);
      drawPile(ground, 0, H + 2);

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(21, 21, 26, 0.6)";
      ctx.beginPath();
      for (f = 0; f < flakes.length; f++) {
        p = flakes[f];
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, 6.283);
      }
      ctx.fill();
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    }

    addEventListener("resize", function () {
      if (raf) size();
    });

    return {
      start: function () {
        if (raf) return;
        size();
        last = performance.now();
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      },
    };
  }
})();
