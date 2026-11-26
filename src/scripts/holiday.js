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

  // Outlined flakes, like the bricks, that fall and sway down the screen.
  function makeSnow(canvas) {
    var ctx = canvas.getContext("2d");
    var W = 0, H = 0, flakes = [], raf = 0, last = 0;

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = innerWidth;
      H = innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var want = Math.min(280, Math.round((W * H) / 4000));
      while (flakes.length < want) flakes.push(flake(true));
      flakes.length = want;
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

    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(21, 21, 26, 0.6)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (var f = 0; f < flakes.length; f++) {
        var p = flakes[f];
        p.phase += p.sway * dt;
        p.y += p.vy * dt;
        p.x += Math.sin(p.phase) * p.drift * dt;
        if (p.x < -10) p.x += W + 20;
        else if (p.x > W + 10) p.x -= W + 20;
        if (p.y > H + 10) p = flakes[f] = flake(false);
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
