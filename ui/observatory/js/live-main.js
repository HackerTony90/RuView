/**
 * Same module as main.js, served under a new URL.
 *
 * The v0.8.8 dashboard service worker cache-first matches
 * observatory/js/main.js and ignores query strings. /ui/observatory-live.html
 * loads this file so a browser that already cached the demo entry still
 * receives the live-only module.
 *
 * Keep this file identical to main.js apart from this header.
 */
import {
  demoOptIn,
  installTokenHook,
  selectObservatoryFrame,
  prepareSameOriginTicket,
  isSameOriginSensingWs,
  sameOriginSensingWs,
  getToken,
  serverEstimateView,
  mountObservatoryDock,
} from '../../live-session.mjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DemoDataGenerator } from './demo-data.js';
import { NebulaBackground } from './nebula-background.js';
import { PostProcessing } from './post-processing.js';
import { FigurePool, SKELETON_PAIRS } from './figure-pool.js';
import { PoseSystem } from './pose-system.js';
import { ScenarioProps } from './scenario-props.js';
import { HudController, DEFAULTS, SETTINGS_VERSION, PRESETS, SCENARIO_NAMES } from './hud-controller.js';

const C = {
  greenGlow:  0x00d878,
  greenBright:0x3eff8a,
  greenDim:   0x0a6b3a,
  amber:      0xffb020,
  blueSignal: 0x2090ff,
  redAlert:   0xff3040,
  redHeart:   0xff4060,
  bgDeep:     0x080c14,
};

class Observatory {
  constructor() {
    this._canvas = document.getElementById('observatory-canvas');
    this.settings = { ...DEFAULTS };
    try {
      const ver = localStorage.getItem('ruview-settings-version');
      if (ver === SETTINGS_VERSION) {
        const saved = localStorage.getItem('ruview-observatory-settings');
        if (saved) Object.assign(this.settings, JSON.parse(saved));
      } else {
        localStorage.removeItem('ruview-observatory-settings');
        localStorage.setItem('ruview-settings-version', SETTINGS_VERSION);
      }
    } catch { /* storage unavailable */ }

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(window.innerWidth, window.innerHeight);
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = this.settings.exposure;
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(C.bgDeep);
    this._scene.fog = new THREE.FogExp2(C.bgDeep, 0.005);

    this._camera = new THREE.PerspectiveCamera(
      this.settings.fov, window.innerWidth / window.innerHeight, 0.1, 300
    );
    this._camera.position.set(6, 5, 8);
    this._camera.lookAt(0, 1.2, 0);

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.minDistance = 2;
    this._controls.maxDistance = 25;
    this._controls.maxPolarAngle = Math.PI * 0.88;
    this._controls.target.set(0, 1.2, 0);
    this._controls.update();

    this._clock = new THREE.Clock();
    this._demoData = new DemoDataGenerator();
    this._demoData.setCycleDuration(this.settings.cycle || 30);
    if (this.settings.scenario && this.settings.scenario !== 'auto') {
      this._demoData.setScenario(this.settings.scenario);
    }
    this._currentData = null;
    this._currentScenario = null;

    this._setupLighting();
    this._nebula = new NebulaBackground(this._scene);
    this._buildRoom();
    this._buildRouter();
    this._poseSystem = new PoseSystem();
    this._figurePool = new FigurePool(this._scene, this.settings, this._poseSystem);
    this._scenarioProps = new ScenarioProps(this._scene);
    this._buildDotMatrixMist();
    this._buildParticleTrail();
    this._buildWifiWaves();
    this._buildSignalField();

    this._postProcessing = new PostProcessing(this._renderer, this._scene, this._camera);
    this._applyPostSettings();
    this._hud = new HudController(this);

    this._autopilot = false;
    this._autoAngle = 0;
    this._fpsFrames = 0;
    this._fpsTime = 0;
    this._fpsValue = 60;
    this._showFps = false;
    this._qualityLevel = 2;

    this._ws = null;
    this._liveData = null;
    this._socketOpened = false;
    this._link = 'starting';
    this._reconnectTimer = null;
    installTokenHook();
    this._dock = mountObservatoryDock({ onTokenChanged: () => this._startLive() });
    this._demoExplicit = demoOptIn(window.location.search);
    this._startLive();

    this._initKeyboard();
    this._hud.initSettings();
    this._hud.initQuickSelect();
    const sourceSelect = document.getElementById('opt-data-source');
    if (sourceSelect && !this._demoExplicit) {
      sourceSelect.value = 'ws';
      sourceSelect.addEventListener('change', (event) => {
        if (event.target.value !== 'ws') {
          event.target.value = 'ws';
          this._startLive();
        }
      });
    }
    this._restTimer = setInterval(() => { void this._pollRest(); }, 2000);
    window.addEventListener('resize', () => this._onResize());
    this._animate();
  }

  _setupLighting() {
    this._ambient = new THREE.AmbientLight(0xccccdd, this.settings.ambient * 5.0);
    this._scene.add(this._ambient);
    this._scene.add(new THREE.HemisphereLight(0x6688bb, 0x203040, 1.2));
    const key = new THREE.DirectionalLight(0xffeedd, 1.2);
    key.position.set(4, 8, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    this._scene.add(key);
    const fill = new THREE.DirectionalLight(0x8899bb, 0.7);
    fill.position.set(-4, 5, -2);
    this._scene.add(fill);
    const rim = new THREE.DirectionalLight(0x6699cc, 0.5);
    rim.position.set(0, 6, -5);
    this._scene.add(rim);
    const overhead = new THREE.PointLight(0x8899aa, 1.0, 20, 1.0);
    overhead.position.set(0, 3.8, 0);
    this._scene.add(overhead);
  }

  _buildRoom() {
    this._grid = new THREE.GridHelper(12, 24, 0x1a4830, 0x0c2818);
    this._grid.material.opacity = 0.5;
    this._grid.material.transparent = true;
    this._scene.add(this._grid);
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(12, 4, 10));
    this._roomWire = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: C.greenDim, opacity: 0.3, transparent: true,
    }));
    this._roomWire.position.y = 2;
    this._scene.add(this._roomWire);
    const floorGeo = new THREE.PlaneGeometry(12, 10);
    this._floorMat = new THREE.MeshStandardMaterial({
      color: 0x101810,
      roughness: 1.0 - this.settings.reflect * 0.7,
      metalness: this.settings.reflect * 0.5,
      emissive: 0x020404,
      emissiveIntensity: 0.08,
    });
    const floor = new THREE.Mesh(floorGeo, this._floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this._scene.add(floor);
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.6, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x6b5840, roughness: 0.55, emissive: 0x1a1408, emissiveIntensity: 0.25 }),
    );
    table.position.set(-4, 0.3, -3);
    table.castShadow = true;
    this._scene.add(table);
  }

  _buildRouter() {
    this._routerGroup = new THREE.Group();
    this._routerGroup.position.set(-4, 0.92, -3);
    this._routerGroup.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.12, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x505060, roughness: 0.2, metalness: 0.7, emissive: 0x101018, emissiveIntensity: 0.2 }),
    ));
    for (let i = -1; i <= 1; i++) {
      const ant = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 0.35),
        new THREE.MeshStandardMaterial({ color: 0x606068, roughness: 0.3, metalness: 0.6, emissive: 0x101018, emissiveIntensity: 0.15 }),
      );
      ant.position.set(i * 0.2, 0.24, 0);
      ant.rotation.z = i * 0.15;
      this._routerGroup.add(ant);
    }
    this._routerLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.025),
      new THREE.MeshBasicMaterial({ color: C.greenGlow }),
    );
    this._routerLed.position.set(0.22, 0.07, 0.18);
    this._routerGroup.add(this._routerLed);
    this._routerLight = new THREE.PointLight(C.blueSignal, 1.2, 8);
    this._routerLight.position.set(0, 0.3, 0);
    this._routerGroup.add(this._routerLight);
    this._scene.add(this._routerGroup);
  }

  _buildWifiWaves() {
    this._wifiWaves = [];
    for (let i = 0; i < 5; i++) {
      const radius = 0.8 + i * 1.0;
      const geo = new THREE.SphereGeometry(radius, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.6);
      const mat = new THREE.MeshBasicMaterial({
        color: C.blueSignal,
        transparent: true, opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false, wireframe: true,
      });
      const shell = new THREE.Mesh(geo, mat);
      shell.position.copy(this._routerGroup.position);
      shell.position.y += 0.5;
      this._scene.add(shell);
      this._wifiWaves.push({ mesh: shell, mat, phase: i * 0.7 });
    }
  }

  _buildDotMatrixMist() {
    const COUNT = 800;
    const positions = new Float32Array(COUNT * 3);
    const alphas = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.5;
      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = Math.random() * 1.8;
      positions[i * 3 + 2] = Math.sin(angle) * r;
      alphas[i] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 3.0 * (200.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float edge = smoothstep(0.5, 0.2, d);
          gl_FragColor = vec4(uColor, edge * vAlpha);
        }
      `,
      uniforms: { uColor: { value: new THREE.Color(this.settings.wireColor) } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._mistPoints = new THREE.Points(geo, mat);
    this._scene.add(this._mistPoints);
    this._mistCount = COUNT;
  }

  _buildParticleTrail() {
    const COUNT = 200;
    const positions = new Float32Array(COUNT * 3);
    const ages = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) ages[i] = 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('age', new THREE.BufferAttribute(ages, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float age;
        varying float vAge;
        void main() {
          vAge = age;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, (1.0 - age) * 5.0 * (150.0 / -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAge;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float alpha = (1.0 - vAge) * 0.6 * smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      uniforms: { uColor: { value: new THREE.Color(C.greenGlow) } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._trail = new THREE.Points(geo, mat);
    this._scene.add(this._trail);
    this._trailHead = 0;
    this._trailCount = COUNT;
    this._trailTimer = 0;
  }

  _buildSignalField() {
    const gridSize = 20;
    const count = gridSize * gridSize;
    const positions = new Float32Array(count * 3);
    this._fieldColors = new Float32Array(count * 3);
    this._fieldSizes = new Float32Array(count);
    for (let iz = 0; iz < gridSize; iz++) {
      for (let ix = 0; ix < gridSize; ix++) {
        const idx = iz * gridSize + ix;
        positions[idx * 3] = (ix - gridSize / 2) * 0.6;
        positions[idx * 3 + 1] = 0.02;
        positions[idx * 3 + 2] = (iz - gridSize / 2) * 0.5;
        this._fieldSizes[idx] = 8;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this._fieldColors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this._fieldSizes, 1));
    this._fieldMat = new THREE.PointsMaterial({
      size: 0.35, vertexColors: true, transparent: true,
      opacity: this.settings.field, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true,
    });
    this._fieldPoints = new THREE.Points(geo, this._fieldMat);
    this._scene.add(this._fieldPoints);
  }

  _initKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (this._hud.settingsOpen) return;
      switch (e.key.toLowerCase()) {
        case 'a':
          this._autopilot = !this._autopilot;
          this._controls.enabled = !this._autopilot;
          break;
        case 'd': this._demoData.cycleScenario(); break;
        case 'f':
          this._showFps = !this._showFps;
          document.getElementById('fps-counter').style.display = this._showFps ? 'block' : 'none';
          break;
        case 's': this._hud.toggleSettings(); break;
        case ' ':
          e.preventDefault();
          this._demoData.paused = !this._demoData.paused;
          break;
        default: break;
      }
    });
  }

  _applyPostSettings() {
    const pp = this._postProcessing;
    pp._bloomPass.strength = this.settings.bloom;
    pp._bloomPass.radius = this.settings.bloomRadius;
    pp._bloomPass.threshold = this.settings.bloomThresh;
    pp._vignettePass.uniforms.uVignetteStrength.value = this.settings.vignette;
    pp._vignettePass.uniforms.uGrainStrength.value = this.settings.grain;
    pp._vignettePass.uniforms.uChromaticStrength.value = this.settings.chromatic;
  }

  _applyColors() {
    const wc = new THREE.Color(this.settings.wireColor);
    const jc = new THREE.Color(this.settings.jointColor);
    this._figurePool.applyColors(wc, jc);
    this._mistPoints.material.uniforms.uColor.value.copy(wc);
  }

  _startLive() {
    if (this._demoExplicit) {
      this._link = 'demo';
      this.settings.dataSource = 'demo';
      this._dock?.setStatus('demo', 'Explicit demo (?demo=1). These figures are synthetic and are not live sensing.');
      return;
    }
    this.settings.dataSource = 'ws';
    this.settings.wsUrl = sameOriginSensingWs(window.location) || '';
    void this._pollRest();
    void this._connectWS(this.settings.wsUrl);
  }

  async _pollRest() {
    if (this._demoExplicit || location.protocol === 'file:') return;
    const headers = { Accept: 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetch('/api/v1/nodes', {
        headers, credentials: 'same-origin', cache: 'no-store',
      });
      if (response.status === 401 || response.status === 403) {
        this._link = 'auth-required';
        this._dock?.setStatus('auth-required', response.status === 401
          ? 'The server requires a token (HTTP 401). Enter it here or choose a one-line token file. Demo figures stay off.'
          : 'The server rejected the token (HTTP 403). Demo figures stay off.');
        this._dock?.setNodes('');
        return;
      }
      if (!response.ok) {
        this._link = 'offline';
        this._dock?.setStatus('offline', `Node status returned HTTP ${response.status}.`);
        return;
      }
      const body = await response.json();
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      const summary = nodes.map((node) => {
        const id = node.node_id ?? node.id;
        const freshness = node.status || 'unknown';
        const rssi = Number.isFinite(node.rssi_dbm) ? `${Math.round(node.rssi_dbm)} dBm` : 'no RSSI';
        return `Node ${id}: ${freshness}, ${rssi}`;
      }).join(' · ');
      this._dock?.setNodes(summary || 'The server returned no nodes.');
      if (this._link !== 'live') {
        this._link = 'no-data';
        this._dock?.setStatus('no-data', nodes.length
          ? 'The API answered with nodes. People are not drawn until a surveyed map exists, and this view does not invent them.'
          : 'The API answered and listed no nodes. Demo figures stay off.');
      }
    } catch {
      if (this._link !== 'live') {
        this._link = 'offline';
        this._dock?.setStatus('offline', 'The sensing API is unreachable. Demo figures stay off.');
      }
    }
  }

  async _connectWS(url) {
    if (this._demoExplicit) return;
    this._disconnectWS();
    if (!isSameOriginSensingWs(url, window.location)) {
      this._link = 'offline';
      this._dock?.setStatus('offline', 'The live stream is opened on this page’s origin only.');
      return;
    }
    const prepared = await prepareSameOriginTicket({ locationLike: window.location });
    if (!prepared.ok) {
      this._link = prepared.auth === 'missing' || prepared.auth === 'rejected' ? 'auth-required' : 'offline';
      this._dock?.setStatus(this._link, prepared.error || 'The live stream is not connected.');
      if (prepared.auth === 'offline') this._scheduleReconnect(url);
      return;
    }
    try {
      this._socketOpened = false;
      this._ws = new WebSocket(prepared.url);
      this._ws.onopen = () => {
        this._socketOpened = true;
        this._link = 'live';
        this._hud.updateSourceBadge('ws', this._ws);
        this._dock?.setStatus('live', 'Live stream connected. Figures are not drawn: server positions are uncalibrated inference, not a measured location.');
      };
      this._ws.onmessage = (evt) => {
        try { this._liveData = JSON.parse(evt.data); } catch { /* ignore malformed frames */ }
      };
      this._ws.onclose = () => {
        const opened = this._socketOpened;
        this._ws = null;
        this._liveData = null;
        this._socketOpened = false;
        if (!opened) {
          this._link = 'auth-required';
          this._dock?.setStatus('auth-required', 'The live stream closed before it opened. If a token is required, enter it above. Demo figures stay off.');
        } else {
          this._link = 'offline';
          this._dock?.setStatus('offline', 'The live stream closed. Demo figures stay off.');
        }
        this._setBadge(this._link === 'auth-required' ? 'AUTH REQUIRED' : 'OFFLINE');
        this._scheduleReconnect(url);
      };
      this._ws.onerror = () => {};
    } catch {
      this._link = 'offline';
      this._dock?.setStatus('offline', 'The browser could not open the live stream.');
    }
  }

  _scheduleReconnect(url) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._demoExplicit) void this._connectWS(url);
    }, 4000);
  }

  _disconnectWS() {
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }
    this._liveData = null;
    this._socketOpened = false;
  }

  _setBadge(text) {
    const label = document.getElementById('data-source-label');
    const dot = document.querySelector('#data-source-badge .dot');
    if (label) label.textContent = text;
    if (dot) dot.className = text === 'LIVE' ? 'dot dot--live' : 'dot dot--demo';
  }

  _showQuiet(mode) {
    const badge = mode === 'auth-required'
      ? 'AUTH REQUIRED'
      : mode === 'offline'
        ? 'OFFLINE'
        : mode === 'live'
          ? 'LIVE'
          : 'NO DATA';
    const label = mode === 'live' ? 'NO DATA' : badge;
    this._setBadge(badge);
    for (const id of ['hr-value', 'br-value', 'conf-value', 'rssi-value', 'var-value', 'motion-value']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '--';
    }
    const presence = document.getElementById('presence-label');
    if (presence) presence.textContent = label;
    const persons = document.getElementById('persons-value');
    if (persons) persons.textContent = '--';
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    const dt = Math.min(this._clock.getDelta(), 0.1);
    const elapsed = this._clock.getElapsedTime();
    const decision = selectObservatoryFrame({
      demoRequested: this._demoExplicit,
      liveFrame: this._liveData,
      link: this._link,
    });
    let data;
    if (decision.useDemoGenerator) {
      data = this._demoData.update(dt);
      this._hud.updateSourceBadge('demo', null);
    } else if (decision.hud === 'server' && decision.serverFrame) {
      const estimate = serverEstimateView(decision.serverFrame) || {};
      data = {
        classification: estimate.classification || {},
        features: {
          mean_rssi: estimate.features?.mean_rssi,
          variance: estimate.features?.variance,
          motion_band_power: estimate.features?.motion_band_power,
        },
        vital_signs: estimate.vitalSigns
          ? {
              heart_rate_bpm: estimate.vitalSigns.heart_rate_bpm,
              breathing_rate_bpm: estimate.vitalSigns.breathing_rate_bpm,
            }
          : {},
        estimated_persons: estimate.estimatedPersons,
        persons: [],
        source: estimate.source,
      };
      this._hud.updateSourceBadge('ws', this._ws);
    } else {
      data = { persons: [], classification: {}, features: {}, vital_signs: {} };
    }
    this._currentData = data;
    this._nebula.update(dt, elapsed);
    this._figurePool.update(decision.drawFigures ? data : { persons: [] }, elapsed);
    this._scenarioProps.update(
      decision.useDemoGenerator ? data : { classification: {} },
      decision.useDemoGenerator ? this._demoData.currentScenario : 'live',
    );
    this._updateDotMatrixMist(decision.drawFigures ? data : { persons: [] }, elapsed);
    this._updateParticleTrail(decision.drawFigures ? data : { persons: [] }, dt, elapsed);
    this._updateWifiWaves(elapsed);
    if (decision.drawSignalField) this._updateSignalField(data);
    if (decision.hud === 'quiet') this._showQuiet(decision.mode);
    else {
      this._hud.updateHUD(data, this._demoData);
      this._hud.updateSparkline(decision.useDemoGenerator ? data : null);
    }
    this._routerLed.material.opacity = 0.5 + 0.5 * Math.sin(elapsed * 8);
    this._routerLight.intensity = 0.3 + 0.2 * Math.sin(elapsed * 3);
    if (this._autopilot) {
      this._autoAngle += dt * this.settings.orbitSpeed;
      const r = 10;
      this._camera.position.set(
        Math.sin(this._autoAngle) * r,
        4.5 + Math.sin(this._autoAngle * 0.5),
        Math.cos(this._autoAngle) * r,
      );
      this._controls.target.set(0, 1.2, 0);
      this._controls.update();
    }
    this._controls.update();
    this._postProcessing.update(elapsed);
    this._postProcessing.render();
    this._updateFPS(dt);
  }

  _updateDotMatrixMist(data, elapsed) {
    const persons = data?.persons || [];
    const isPresent = data?.classification?.presence || false;
    const pos = this._mistPoints.geometry.attributes.position;
    const alpha = this._mistPoints.geometry.attributes.alpha;
    if (!isPresent || persons.length === 0) {
      for (let i = 0; i < this._mistCount; i++) alpha.array[i] = Math.max(0, alpha.array[i] - 0.02);
      alpha.needsUpdate = true;
      return;
    }
    const pp = persons[0].position || [0, 0, 0];
    for (let i = 0; i < this._mistCount; i++) {
      pos.array[i * 3] += ((pp[0] || 0) - pos.array[i * 3]) * 0.05;
      pos.array[i * 3 + 1] += (0.8 - pos.array[i * 3 + 1]) * 0.05;
      pos.array[i * 3 + 2] += ((pp[2] || 0) - pos.array[i * 3 + 2]) * 0.05;
      alpha.array[i] = 0.2;
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;
  }

  _updateParticleTrail(data, dt) {
    if (this.settings.trail <= 0) return;
    const ages = this._trail.geometry.attributes.age;
    for (let i = 0; i < this._trailCount; i++) ages.array[i] = Math.min(1, ages.array[i] + dt * 0.8);
    ages.needsUpdate = true;
    void data;
  }

  _updateWifiWaves(elapsed) {
    for (const w of this._wifiWaves) {
      const t = (elapsed * 0.8 + w.phase) % 4.5;
      const life = t / 4.5;
      w.mat.opacity = Math.max(0, this.settings.waves * 0.25 * (1 - life));
      const scale = 1 + life * 0.6;
      w.mesh.scale.set(scale, scale, scale);
      w.mesh.rotation.y = elapsed * 0.05;
    }
  }

  _updateSignalField(data) {
    const field = data?.signal_field?.values;
    if (!field) return;
    const count = Math.min(field.length, 400);
    for (let i = 0; i < count; i++) {
      const v = field[i] || 0;
      this._fieldColors[i * 3] = v;
      this._fieldColors[i * 3 + 1] = v;
      this._fieldColors[i * 3 + 2] = v;
      this._fieldSizes[i] = 5 + v * 15;
    }
    this._fieldPoints.geometry.attributes.color.needsUpdate = true;
    this._fieldPoints.geometry.attributes.size.needsUpdate = true;
  }

  _updateFPS(dt) {
    this._fpsFrames++;
    this._fpsTime += dt;
    if (this._fpsTime >= 1) {
      this._fpsValue = Math.round(this._fpsFrames / this._fpsTime);
      this._fpsFrames = 0;
      this._fpsTime = 0;
      if (this._showFps) {
        document.getElementById('fps-counter').textContent = `${this._fpsValue} FPS`;
      }
      this._adaptQuality();
    }
  }

  _adaptQuality() {
    let nl = this._qualityLevel;
    if (this._fpsValue < 25 && nl > 0) nl--;
    else if (this._fpsValue > 55 && nl < 2) nl++;
    if (nl !== this._qualityLevel) {
      this._qualityLevel = nl;
      this._nebula.setQuality(nl);
      this._postProcessing.setQuality(nl);
    }
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
    this._postProcessing.resize(w, h);
  }
}

new Observatory();
void SKELETON_PAIRS;
void SCENARIO_NAMES;
void PRESETS;
