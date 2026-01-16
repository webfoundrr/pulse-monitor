class PulseMonitor {
  constructor(opt = {}) {
    this.url = opt.url || null;
    this.batchSize = opt.batch || 5;
    this.window = opt.window || 3000;
    this.threshold = opt.threshold || {
      click: { warn: 2, err: 3 },
      fetch: { warn: 3, err: 5 }
    };

    this.queue = [];
    this.last = Date.now();
    this.sid = Math.random().toString(16).slice(2);

    // Snapshot оригиналов для обхода рекурсии при логировании
    this.originalFetch = window.fetch.bind(window);
    this.originalBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;

    this.initWorker();
    this.initUI();
    this.bind();
  }

  initWorker() {
    const code = `
      let state = {};

      self.onmessage = (e) => {
        const { type, val, time, window, meta } = e.data;

        if (!state[type]) {
          state[type] = { list: [], rate: 0, hidden: 0, load: 0 };
        }

        const g = state[type];
        g.list.push({ v: val, t: time });

        // Сдвиг окна
        while (g.list.length && time - g.list[0].t > window) {
          g.list.shift();
        }

        g.rate = g.list.length;
        if (meta?.ctx === 'hidden') g.hidden++;
        if (type === 'longtask') {
          g.load = g.list.reduce((a,b)=>a+b.v,0);
        }

        let st = 'ok';

        // Плотность событий
        if (g.rate > 6 && meta?.ctx === 'hidden') st = 'err';

        // Скрытая сеть
        if (type === 'fetch' && meta?.ctx === 'hidden') {
            if (st !== 'err') st = 'warn';
        }
        if (type === 'beacon' && meta?.ctx !== 'unload') st = 'err';

        // Нагрузка CPU / Майнинг
        if (type === 'longtask') {
          if (g.load > 200 && g.rate > 3) st = 'err';
          else if (g.load > 100) st = 'warn';
        }

        // Спам воркера
        if (type === 'worker_msg' && g.rate > 10) st = 'err';
        if (type === 'worker_create' && meta?.ctx === 'hidden') st = 'warn';

        // Корреляция CPU + Worker
        if (
          state.worker_msg?.rate > 5 &&
          state.longtask?.load > 100
        ) {
          st = 'err';
        }

        self.postMessage({ res: { type, val, st }, avg: g.rate });
      };
    `;

    const blob = new Blob([code], { type: 'text/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));

    // Обработка вердиктов воркера и управление очередью
    this.worker.addEventListener('message', (e) => {
      const { res, avg } = e.data;

      this.updateUI(res.st, avg);

      if (res.st === 'err') this.sendImmediate(res);
      else this.queue.push(res);

      if (this.queue.length >= this.batchSize) this.send();
    });
  }

  tick(type, meta = {}) {
    const now = Date.now();
    const delta = now - this.last;
    this.last = now;

    this.worker.postMessage({
      type,
      val: typeof meta === 'number' ? meta : delta,
      time: now,
      window: this.window,
      meta
    });
  }

  bind() {
    let user = false;
    let userTimer;
    
    // Трекинг пользовательского фокуса (TTL 1s)
    const mark = () => { 
        user = true; 
        clearTimeout(userTimer);
        userTimer = setTimeout(() => user = false, 1000); 
    };

    document.addEventListener('click', () => {
      mark();
      this.tick('click', { ctx: 'user' });
    });
    document.addEventListener('keydown', () => {
      mark();
      this.tick('key', { ctx: 'user' });
    });

    // Инъекция в сетевой стек для анализа контекста вызова
    const oldFetch = window.fetch;
    window.fetch = (...a) => {
      this.tick('fetch', {
        ctx: user ? 'user' : 'hidden',
        url: a[0]?.toString()
      });
      return oldFetch(...a);
    };

    const oldBeacon = navigator.sendBeacon;
    navigator.sendBeacon = (...a) => {
      this.tick('beacon', {
        ctx: document.visibilityState === 'hidden' ? 'unload' : 'hidden',
        url: a[0]?.toString()
      });
      return oldBeacon.apply(navigator, a);
    };

    // Наблюдение за блокировками потока
    if ('PerformanceObserver' in window) {
      const obs = new PerformanceObserver((list) => {
        list.getEntries().forEach(e => {
          this.tick('longtask', { ctx:'hidden', duration:e.duration });
        });
      });
      obs.observe({ entryTypes:['longtask'] });
    }

    // Мониторинг жизненного цикла и активности дочерних воркеров
    const OldWorker = window.Worker;
    window.Worker = (...a) => {
      const w = new OldWorker(...a);

      this.tick('worker_create', { ctx:'hidden' });

      const oldPost = w.postMessage;
      w.postMessage = (...m) => {
        this.tick('worker_msg', { ctx:'hidden' });
        return oldPost.apply(w, m);
      };

      return w;
    };
  }

  send() {
    if (!this.queue.length || !this.url) return;
    const body = JSON.stringify({ sid:this.sid, data:this.queue });
    this.queue = [];
    
    // Использование нативных методов во избежание циклического перехвата
    if (this.originalBeacon) {
        this.originalBeacon(this.url, body);
    } else {
        this.originalFetch(this.url, { method:'POST', body, keepalive:true });
    }
  }

  sendImmediate(data) {
    if (!this.url) return;
    const body = JSON.stringify({ sid:this.sid, data:[data] });
    
    if (this.originalBeacon) {
        this.originalBeacon(this.url, body);
    } else {
        this.originalFetch(this.url, { method:'POST', body, keepalive:true });
    }
  }

  initUI() {
    this.dot = document.createElement('div');
    this.dot.style.cssText =
      'width:10px;height:10px;border-radius:50%;position:fixed;bottom:10px;right:10px;background:#0f0;z-index:9999;';
    document.body.appendChild(this.dot);
  }

  updateUI(st, avg) {
    const c = { ok:'#0f0', warn:'#ff0', err:'#f00' };
    this.dot.style.background = c[st];
    this.dot.title = `${st} | RPS: ${avg}`;
  }
}rl, { method:'POST', body, keepalive:true });
    }
  }

  sendImmediate(data) {
    if (!this.url) return;
    const body = JSON.stringify({ sid:this.sid, data:[data] });
    
    // Use original functions to avoid infinite recursion loop
    if (this.originalBeacon) {
        this.originalBeacon(this.url, body);
    } else {
        this.originalFetch(this.url, { method:'POST', body, keepalive:true });
    }
  }

  initUI() {
    this.dot = document.createElement('div');
    this.dot.style.cssText =
      'width:10px;height:10px;border-radius:50%;position:fixed;bottom:10px;right:10px;background:#0f0;';
    document.body.appendChild(this.dot);
  }

  updateUI(st, avg) {
    const c = { ok:'#0f0', warn:'#ff0', err:'#f00' };
    this.dot.style.background = c[st];
    this.dot.title = st + ' | ' + avg;
  }
}
