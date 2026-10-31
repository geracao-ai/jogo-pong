const { test, expect } = require('@playwright/test');

// On-screen paddle thickness on the smallest phone tested (the original was under 7px there)
const MIN_PADDLE_THICKNESS_PX = 13;

async function open(page) {
  await page.goto('/');
  await page.waitForFunction(() => view.scale > 0);
}

async function start(page) {
  await open(page);
  await page.locator('#startOverlay').tap();
  await expect(page.locator('#startOverlay')).toBeHidden();

  // The sensor listener is attached only after the async permission answer, so keep
  // sending readings until one lands, as a real sensor would
  await expect.poll(async () => {
    await sendTilt(page, 0, 0);
    return page.evaluate(() => tilt.angle);
  }, { intervals: [20] }).not.toBeNull();
}

// Fakes the sensor. A plain Event works on every engine, unlike the DeviceOrientationEvent constructor.
async function sendTilt(page, beta, gamma) {
  await page.evaluate(([b, g]) => {
    const e = new Event('deviceorientation');
    e.beta = b;
    e.gamma = g;
    window.dispatchEvent(e);
  }, [beta, gamma]);
}

// Holds a tilt long enough for the paddle smoothing to settle, whatever the emulated frame rate
async function holdTilt(page, beta, gamma) {
  await sendTilt(page, beta, gamma);
  await page.waitForTimeout(150); // Lets the paddle start moving before watching it stop
  await page.evaluate(() => { window.__lastY = undefined; });
  await page.waitForFunction(() => {
    const y = player.y;
    const settled = window.__lastY !== undefined && Math.abs(window.__lastY - y) < 0.01;
    window.__lastY = y;
    return settled;
  }, null, { polling: 100 });
}

async function setScreenAngle(page, angle) {
  await page.evaluate((a) => {
    Object.defineProperty(window, 'orientation', { configurable: true, get: () => a });
    resize();
  }, angle);
}

const paddleCenterOnScreen = (page) => page.evaluate(() => {
  const r = canvas.getBoundingClientRect();
  const along = (player.y + player.height / 2) * view.scale;
  const across = (player.x + player.width / 2) * view.scale;
  return view.rotated
    ? { x: r.left + 2 + along, y: r.bottom - 2 - across }
    : { x: r.left + 2 + across, y: r.top + 2 + along };
});

test.describe('celular', () => {
  test.beforeEach(({ isMobile }) => test.skip(!isMobile));

  test('tela não rola e o campo inteiro cabe na tela', async ({ page }, info) => {
    await start(page);
    await page.evaluate(() => window.scrollTo(300, 300));

    const m = await page.evaluate(() => {
      const r = canvas.getBoundingClientRect();
      const e = document.documentElement;
      return {
        scrollX: window.scrollX, scrollY: window.scrollY,
        overflowX: e.scrollWidth - innerWidth, overflowY: e.scrollHeight - innerHeight,
        left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom,
        vw: innerWidth, vh: innerHeight, w: r.width, h: r.height,
      };
    });
    expect([m.scrollX, m.scrollY]).toEqual([0, 0]);
    expect(m.overflowX).toBeLessThanOrEqual(0);
    expect(m.overflowY).toBeLessThanOrEqual(0);
    for (const side of [m.left, m.top, m.right, m.bottom]) expect(side).toBeGreaterThanOrEqual(0);

    // The field must use the screen: its long side follows the screen's long side
    expect(Math.max(m.w / m.vw, m.h / m.vh)).toBeGreaterThan(0.95);
    expect(m.w > m.h).toBe(m.vw > m.vh);

    await page.waitForTimeout(350);
    await page.screenshot({ path: `test-results/telas/${info.project.name.replaceAll(' ', '-')}.png` });
  });

  test('deslizar o dedo não rola a página', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'gesto real só existe via CDP');
    await start(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizeScrollGesture', {
      x: 100, y: 200, yDistance: -300, xDistance: -100, gestureSourceType: 'touch',
    });
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0]);
  });

  test('barra do jogador é grossa e está visível nas duas pontas', async ({ page }) => {
    await start(page);
    const thickness = await page.evaluate(() => player.width * view.scale);
    expect(thickness).toBeGreaterThanOrEqual(MIN_PADDLE_THICKNESS_PX);

    for (const end of ['top', 'bottom']) {
      const pixel = await page.evaluate((where) => {
        player.y = where === 'top' ? 0 : FIELD_HEIGHT - player.height;
        render();
        const s = view.scale * view.dpr;
        const along = (player.y + player.height / 2) * s;
        const across = (player.x + player.width / 2) * s;
        const px = view.rotated ? along : across;
        const py = view.rotated ? canvas.height - across : along;
        return [...ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data];
      }, end);
      expect(pixel).toEqual([255, 255, 255, 255]);
    }
  });

  test('em pé o jogador fica embaixo; deitado, à esquerda', async ({ page }) => {
    await start(page);
    const c = await paddleCenterOnScreen(page);
    const vp = page.viewportSize();
    if (vp.height > vp.width) expect(c.y).toBeGreaterThan(vp.height * 0.7);
    else expect(c.x).toBeLessThan(vp.width * 0.3);
  });

  test('canvas tem resolução nativa da tela', async ({ page }) => {
    await start(page);
    const r = await page.evaluate(() => ({
      ratio: canvas.width / (canvas.getBoundingClientRect().width - 4),
      dpr: devicePixelRatio,
    }));
    expect(r.ratio).toBeCloseTo(r.dpr, 1);
  });

  test('inclinar move a barra no sentido certo e alcança as pontas', async ({ page }) => {
    await start(page);
    const landscape = await page.evaluate(() => !view.rotated);
    const angles = landscape ? [90, 270] : [0];

    for (const angle of angles) {
      await setScreenAngle(page, angle);
      // "Positive" lowers the screen's bottom edge when lying down, and its right edge when upright
      const sign = angle === 90 ? -1 : 1;
      const rest = landscape ? 40 * sign : 0; // Lying down, people hold the phone angled at them

      await page.evaluate(() => { tilt.angle = null; tilt.neutral = null; player.y = 150; });
      await holdTilt(page, 0, rest);
      expect(await page.evaluate(() => player.y)).toBeCloseTo(150, 0);

      await holdTilt(page, 0, rest + 30 * sign);
      expect(await page.evaluate(() => player.y)).toBeCloseTo(300, 0);

      await holdTilt(page, 0, rest - 30 * sign);
      expect(await page.evaluate(() => player.y)).toBeCloseTo(0, 0);
    }
  });

  test('voltar a inclinação reage na hora, sem zona morta', async ({ page }) => {
    await start(page);
    const axis = await page.evaluate(() => (view.rotated ? 0 : 1));
    if (axis) await setScreenAngle(page, 270);

    await holdTilt(page, 0, 0);
    await holdTilt(page, 0, 45);
    await holdTilt(page, 0, 40); // 5 degrees back from the far end
    const y = await page.evaluate(() => player.y);
    expect(y).toBeLessThan(290);
    expect(y).toBeGreaterThan(240);
  });

  test('passar da vertical não faz a barra pular', async ({ page }) => {
    await start(page);
    test.skip(await page.evaluate(() => view.rotated), 'caso típico do celular deitado');
    await setScreenAngle(page, 90);
    await holdTilt(page, 0, -80);
    const before = await page.evaluate(() => player.y);
    // Same physical pose around vertical, reported by the browser with flipped Euler angles
    await holdTilt(page, 180, 80);
    expect(await page.evaluate(() => player.y)).toBeCloseTo(before, 0);
  });

  test('sensor real do navegador move a barra', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'override de sensor só existe via CDP');
    await start(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 45, gamma: 0 });
    await page.waitForFunction(() => tilt.neutral !== null);
    await page.evaluate(() => { tilt.neutral = null; });
    await page.waitForFunction(() => tilt.neutral !== null);
    const landscape = await page.evaluate(() => !view.rotated);
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', {
      alpha: 0, beta: 45, gamma: landscape ? -20 : 20, // Emulated landscape reports angle 90
    });
    await page.waitForFunction(() => player.y > 200);
  });

  test('arrastar o dedo move a barra e o sensor retoma sem pulo', async ({ page }) => {
    await start(page);
    await holdTilt(page, 0, 0);

    const touch = async (type, x, y) => page.evaluate(([t, px, py]) => {
      const touches = t === 'touchend' ? [] : [{ clientX: px, clientY: py }];
      const e = new Event(t, { cancelable: true });
      e.touches = touches;
      window.dispatchEvent(e);
    }, [type, x, y]);

    const r = await page.evaluate(() => {
      const b = canvas.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, rotated: view.rotated };
    });
    const at = (f) => (r.rotated ? [r.x + r.w * f, r.y + r.h / 2] : [r.x + r.w / 2, r.y + r.h * f]);

    await touch('touchstart', ...at(0.25));
    await touch('touchmove', ...at(0.75));
    const dragged = await page.evaluate(() => player.y + player.height / 2);
    expect(dragged).toBeCloseTo(300, -1);

    await touch('touchend', 0, 0);
    await sendTilt(page, 0, 0);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => player.y + player.height / 2)).toBeCloseTo(dragged, 0);
  });

  test('girar o celular no meio do jogo refaz o layout', async ({ page }) => {
    await start(page);
    const vp = page.viewportSize();
    await holdTilt(page, 0, 10);
    const before = await page.evaluate(() => player.y);
    await page.setViewportSize({ width: vp.height, height: vp.width });

    await expect.poll(() => page.evaluate(() => view.rotated)).toBe(vp.width > vp.height);
    await holdTilt(page, 0, 0);
    expect(await page.evaluate(() => player.y)).toBeCloseTo(before, 0); // The new pose is the new neutral

    const r = await page.evaluate(() => {
      const b = canvas.getBoundingClientRect();
      return { left: b.left, top: b.top, right: innerWidth - b.right, bottom: innerHeight - b.bottom };
    });
    for (const side of Object.values(r)) expect(side).toBeGreaterThanOrEqual(0);
  });

  test('jogo espera o toque; iOS pede permissão dentro do toque', async ({ page }) => {
    await page.addInitScript(() => {
      window.__asked = 0;
      DeviceOrientationEvent.requestPermission = async () => { window.__asked++; return 'granted'; };
    });
    await open(page);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => ball.x)).toBe(400);

    await page.locator('#startOverlay').tap();
    await expect.poll(() => page.evaluate(() => ball.x)).not.toBe(400);
    expect(await page.evaluate(() => window.__asked)).toBe(1);

    await holdTilt(page, 0, 0);
    await holdTilt(page, 0, 40);
    expect(await page.evaluate(() => tilt.angle)).not.toBeNull();
  });

  test('permissão negada: o jogo roda e só ignora o sensor', async ({ page }) => {
    await page.addInitScript(() => {
      DeviceOrientationEvent.requestPermission = async () => 'denied';
    });
    await open(page);
    await page.locator('#startOverlay').tap();
    await expect.poll(() => page.evaluate(() => ball.x)).not.toBe(400);
    await sendTilt(page, 0, 40);
    expect(await page.evaluate(() => tilt.angle)).toBeNull();
  });

  test('em HTTP avisa que a inclinação não funciona; em HTTPS/localhost, não', async ({ page }) => {
    await open(page);
    await expect(page.locator('#tiltWarning')).toBeHidden();

    const html = await (await page.request.get('/')).text();
    await page.route('http://pong.test/', (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://pong.test/');
    await expect(page.locator('#tiltWarning')).toBeVisible();
  });

  test('notch não cobre a barra', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'safe area só é emulada via CDP');
    const vp = page.viewportSize();
    test.skip(vp.height > vp.width, 'notch fica nas laterais com o celular deitado');
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 0, left: 47, bottom: 21, right: 47 },
    });
    await expect.poll(() => page.evaluate(() => canvas.getBoundingClientRect().left)).toBeGreaterThanOrEqual(47);
    const r = await page.evaluate(() => innerWidth - canvas.getBoundingClientRect().right);
    expect(r).toBeGreaterThanOrEqual(47);
  });
});

test('barra grossa conta uma batida só por rebatida', async ({ page, isMobile }) => {
  await page.goto('/');
  if (isMobile) await page.locator('#startOverlay').tap();
  await page.evaluate(() => {
    player.y = 150;
    ball.x = 90; ball.y = 200; ball.speed = 5; ball.velocityX = -5; ball.velocityY = 0;
  });
  await page.waitForFunction(() => ball.velocityX > 0);
  await page.waitForFunction(() => ball.x > 120);
  expect(await page.evaluate(() => ball.speed)).toBe(5.5);
});

test('desktop continua igual: sem tela de início, 800x400, teclado funciona', async ({ page, isMobile }) => {
  test.skip(isMobile);
  await page.goto('/');
  await expect(page.locator('#startOverlay')).toBeHidden();
  await expect(page.locator('#controls')).toBeVisible();

  const box = await page.locator('#pongCanvas').boundingBox();
  expect([box.width, box.height]).toEqual([804, 404]);

  await expect.poll(() => page.evaluate(() => ball.x)).not.toBe(400);
  const y = await page.evaluate(() => player.y);
  await page.keyboard.down('ArrowDown');
  await expect.poll(() => page.evaluate(() => player.y)).toBeGreaterThan(y);
  await page.keyboard.up('ArrowDown');
  expect(await page.evaluate(() => scrollY)).toBe(0);
});
