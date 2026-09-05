import { DurableObject } from "cloudflare:workers";

export class StreamifyDO extends DurableObject {
  sessions: Set<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Set();
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Esperando conexão WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.sessions.add(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    for (const session of this.sessions) {
      try {
        session.send(message);
      } catch (err) {
        this.sessions.delete(session);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.sessions.delete(ws);
  }
}

export interface Env {
  DB: D1Database;
  STREAMIFY_DO: DurableObjectNamespace;
  STREAMIFY_KV: KVNamespace;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/ws') {
      const id = env.STREAMIFY_DO.idFromName("global-streamify-room");
      const stub = env.STREAMIFY_DO.get(id);
      return stub.fetch(request);
    }

    if (path === '/api/register' && method === 'POST') {
      try {
        const { username, password, channelName } = await request.json() as any;
        if (!username || !password || !channelName) {
          return new Response(JSON.stringify({ error: 'Preencha todos os campos.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const cleanUsername = username.startsWith('@') ? username : `@${username}`;
        
        const existing = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(cleanUsername).first();
        if (existing) {
          return new Response(JSON.stringify({ error: 'Este username já está em uso.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        await env.DB.prepare('INSERT INTO users (username, password, channel_name) VALUES (?, ?, ?)').bind(cleanUsername, password, channelName).run();
        return new Response(JSON.stringify({ success: true, message: 'Conta criada com sucesso!' }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err: any) {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            channel_name TEXT
          )
        `).run();
        return new Response(JSON.stringify({ error: 'Erro ao registrar, tente novamente.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/api/login' && method === 'POST') {
      try {
        const { username, password } = await request.json() as any;
        const cleanUsername = username.startsWith('@') ? username : `@${username}`;
        
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND password = ?').bind(cleanUsername, password).first();
        if (!user) {
          return new Response(JSON.stringify({ error: 'Credenciais inválidas.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({ success: true, user: { username: user.username, channelName: user.channel_name } }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Erro no servidor.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // --- API: POSTAR VÍDEO (Bloqueio estrito de SVG) ---
    if (path === '/api/videos' && method === 'POST') {
      try {
        const { title, videoUrl, channelName } = await request.json() as any;
        if (!title || !videoUrl || !channelName) {
          return new Response(JSON.stringify({ error: 'Dados incompletos.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        // Validação estrita e redundante para impedir qualquer vestígio de SVG no iframe/url ou título
        if (/<svg/i.test(videoUrl) || /svg/i.test(title) || /<.*?svg.*?>/i.test(videoUrl)) {
          return new Response(JSON.stringify({ error: 'Segurança: O uso de elementos SVG em iframes ou URLs de vídeo é estritamente proibido.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            video_url TEXT,
            channel_name TEXT,
            likes INTEGER DEFAULT 0,
            dislikes INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `).run();

        await env.DB.prepare('INSERT INTO videos (title, video_url, channel_name, likes, dislikes, views) VALUES (?, ?, ?, 0, 0, 0)').bind(title, videoUrl, channelName).run();
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Erro ao postar vídeo.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // --- API: INTERAÇÃO (Exige verificação de conta no backend) ---
    if (path === '/api/interaction' && method === 'POST') {
      try {
        const { videoId, action, userChannel } = await request.json() as any;
        
        if (!userChannel) {
          return new Response(JSON.stringify({ error: 'Você precisa entrar em uma conta para interagir (seguir, curtir ou descurtir).' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            video_url TEXT,
            channel_name TEXT,
            likes INTEGER DEFAULT 0,
            dislikes INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `).run();

        if (action === 'like') {
          await env.DB.prepare('UPDATE videos SET likes = likes + 1 WHERE id = ?').bind(videoId).run();
        } else if (action === 'dislike') {
          await env.DB.prepare('UPDATE videos SET dislikes = dislikes + 1 WHERE id = ?').bind(videoId).run();
        } else if (action === 'view') {
          await env.DB.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').bind(videoId).run();
        }

        const updatedVideo = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first();
        return new Response(JSON.stringify({ success: true, video: updatedVideo }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Erro ao registrar interação.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/api/videos' && method === 'GET') {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            video_url TEXT,
            channel_name TEXT,
            likes INTEGER DEFAULT 0,
            dislikes INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `).run();

        const { results } = await env.DB.prepare('SELECT * FROM videos ORDER BY id DESC').all();
        return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Streamify</title>
          <style>
              * { box-sizing: border-box; margin: 0; padding: 0; font-family: Roboto, Arial, sans-serif; }
              body { background-color: #0f0f0f; color: #fff; }
              header { display: flex; justify-content: space-between; align-items: center; padding: 10px 24px; background-color: #212121; position: sticky; top: 0; z-index: 100; border-bottom: 1px solid #303030; }
              .logo-area { display: flex; align-items: center; gap: 12px; cursor: pointer; }
              .logo-text { font-size: 22px; font-weight: bold; letter-spacing: -1px; color: #ff0033; }
              .user-section { display: flex; align-items: center; gap: 15px; }
              button { background: #3ea6ff; border: none; color: #0f0f0f; padding: 8px 16px; border-radius: 18px; font-weight: bold; cursor: pointer; transition: 0.2s; }
              button:hover { background: #65b8ff; }
              .btn-secondary { background: transparent; color: #fff; border: 1px solid #303030; }
              .btn-secondary:hover { background: rgba(255,255,255,0.1); }
              .btn-action { background: #272727; color: #f1f1f1; border-radius: 16px; padding: 6px 12px; font-size: 13px; display: flex; align-items: center; gap: 6px; }
              .btn-action:hover { background: #3f3f3f; }
              
              .container { max-width: 1400px; margin: 24px auto; padding: 0 16px; }
              .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
              .card { background: #1f1f1f; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; border: 1px solid #303030; }
              .video-wrapper { position: relative; width: 100%; padding-top: 56.25%; background: #000; }
              .video-wrapper iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
              .card-info { padding: 14px; display: flex; flex-direction: column; gap: 8px; }
              .card-title { font-size: 15px; font-weight: 500; color: #f1f1f1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
              .card-meta-row { display: flex; justify-content: space-between; align-items: center; }
              .card-channel { font-size: 14px; color: #aaa; display: flex; align-items: center; gap: 8px; }
              .btn-follow { background: #fff; color: #0f0f0f; padding: 4px 10px; font-size: 12px; border-radius: 12px; cursor: pointer; }
              .btn-follow.following { background: #333; color: #aaa; }
              .actions-row { display: flex; gap: 8px; margin-top: 4px; }

              .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); justify-content: center; align-items: center; z-index: 1000; }
              .modal-content { background: #212121; padding: 30px; border-radius: 12px; width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 15px; border: 1px solid #303030; }
              .modal-content h2 { margin-bottom: 5px; font-size: 22px; }
              input { width: 100%; padding: 12px; background: #121212; border: 1px solid #303030; border-radius: 8px; color: #fff; font-size: 14px; }
              input:focus { border-color: #3ea6ff; outline: none; }
              .hidden { display: none !important; }
              .flex-row { display: flex; gap: 10px; justify-content: flex-end; }
          </style>
      </head>
      <body>

          <header>
              <div class="logo-area" onclick="location.reload()">
                  <span class="logo-text">Streamify</span>
              </div>
              <div class="user-section" id="userSection">
                  <button class="btn-secondary" onclick="openModal('loginModal')">Entrar</button>
                  <button onclick="openModal('registerModal')">Criar Conta</button>
              </div>
          </header>

          <div class="container">
              <div id="actionToolbar" class="hidden" style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
                  <h3 id="welcomeChannel" style="color: #aaa; font-weight: normal;"></h3>
                  <button onclick="openModal('uploadModal')">+ Postar Vídeo</button>
              </div>
              <div class="grid" id="videoGrid"></div>
          </div>

          <div id="registerModal" class="modal">
              <div class="modal-content">
                  <h2>Criar Conta</h2>
                  <input type="text" id="regUser" placeholder="Username (ex: @meucanal)">
                  <input type="text" id="regChannel" placeholder="Nome do Canal">
                  <input type="password" id="regPass" placeholder="Senha">
                  <div class="flex-row">
                      <button class="btn-secondary" onclick="closeModal('registerModal')">Cancelar</button>
                      <button onclick="register()">Registrar</button>
                  </div>
              </div>
          </div>

          <div id="loginModal" class="modal">
              <div class="modal-content">
                  <h2>Entrar</h2>
                  <input type="text" id="logUser" placeholder="Username (@...)">
                  <input type="password" id="logPass" placeholder="Senha">
                  <div class="flex-row">
                      <button class="btn-secondary" onclick="closeModal('loginModal')">Cancelar</button>
                      <button onclick="login()">Entrar</button>
                  </div>
              </div>
          </div>

          <div id="uploadModal" class="modal">
              <div class="modal-content">
                  <h2>Postar Vídeo</h2>
                  <input type="text" id="vidTitle" placeholder="Título do Vídeo">
                  <input type="text" id="vidUrl" placeholder="Link incorporável (URL de IFrame / Embed)">
                  <div class="flex-row">
                      <button class="btn-secondary" onclick="closeModal('uploadModal')">Cancelar</button>
                      <button onclick="uploadVideo()">Publicar</button>
                  </div>
              </div>
          </div>

          <script>
              let currentUser = JSON.parse(localStorage.getItem('streamify_user')) || null;
              let followingChannels = JSON.parse(localStorage.getItem('streamify_following')) || [];
              
              const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
              const ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws\`);

              ws.onmessage = (event) => {
                  try {
                      const data = JSON.parse(event.data);
                      if (data.type === 'update_video' || data.type === 'new_video') {
                          loadVideos();
                      }
                  } catch (e) {}
              };

              function updateUI() {
                  const userSec = document.getElementById('userSection');
                  const toolbar = document.getElementById('actionToolbar');
                  const welcome = document.getElementById('welcomeChannel');

                  if (currentUser) {
                      userSec.innerHTML = \`<span style="font-weight: bold; color: #3ea6ff;">\${currentUser.channelName} (\${currentUser.username})</span> <button class="btn-secondary" onclick="logout()">Sair</button>\`;
                      toolbar.classList.remove('hidden');
                      welcome.innerText = \`Bem-vindo de volta, \${currentUser.channelName}\`;
                  } else {
                      userSec.innerHTML = \`<button class="btn-secondary" onclick="openModal('loginModal')">Entrar</button><button onclick="openModal('registerModal')">Criar Conta</button>\`;
                      toolbar.classList.add('hidden');
                  }
                  loadVideos();
              }

              function openModal(id) { document.getElementById(id).style.display = 'flex'; }
              function closeModal(id) { document.getElementById(id).style.display = 'none'; }

              async function register() {
                  const username = document.getElementById('regUser').value;
                  const channelName = document.getElementById('regChannel').value;
                  const password = document.getElementById('regPass').value;

                  const res = await fetch('/api/register', {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ username, password, channelName })
                  });
                  const data = await res.json();
                  if (res.ok) {
                      alert(data.message);
                      closeModal('registerModal');
                      openModal('loginModal');
                  } else {
                      alert(data.error);
                  }
              }

              async function login() {
                  const username = document.getElementById('logUser').value;
                  const password = document.getElementById('logPass').value;

                  const res = await fetch('/api/login', {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ username, password })
                  });
                  const data = await res.json();
                  if (res.ok) {
                      currentUser = data.user;
                      localStorage.setItem('streamify_user', JSON.stringify(currentUser));
                      closeModal('loginModal');
                      updateUI();
                  } else {
                      alert(data.error);
                  }
              }

              function logout() {
                  localStorage.removeItem('streamify_user');
                  currentUser = null;
                  updateUI();
              }

              async function uploadVideo() {
                  const title = document.getElementById('vidTitle').value;
                  const videoUrl = document.getElementById('vidUrl').value;

                  if (!title || !videoUrl) {
                      alert('Preencha todos os campos.');
                      return;
                  }

                  // Validação rigorosa no Front-end banindo qualquer tag ou referência a SVG
                  if (/svg/i.test(videoUrl) || /svg/i.test(title)) {
                      alert('Erro de Segurança: O uso de SVG em iframes ou títulos é banido na plataforma.');
                      return;
                  }

                  const res = await fetch('/api/videos', {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ title, videoUrl, channelName: currentUser.channelName })
                  });

                  const data = await res.json();
                  if (res.ok) {
                      closeModal('uploadModal');
                      document.getElementById('vidTitle').value = '';
                      document.getElementById('vidUrl').value = '';
                      ws.send(JSON.stringify({ type: 'new_video' }));
                      loadVideos();
                  } else {
                      alert(data.error || 'Erro ao publicar vídeo.');
                  }
              }

              async function interact(videoId, action) {
                  // Exigir conta ativa para curtir, descurtir ou seguir
                  if (!currentUser) {
                      alert('Você precisa ter uma conta e estar logado para realizar esta ação.');
                      openModal('loginModal');
                      return;
                  }

                  const res = await fetch('/api/interaction', {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ videoId, action, userChannel: currentUser.channelName })
                  });
                  
                  const data = await res.json();
                  if (res.ok) {
                      ws.send(JSON.stringify({ type: 'update_video', videoId }));
                      loadVideos();
                  } else {
                      alert(data.error || 'Erro ao interagir.');
                  }
              }

              function toggleFollow(channelName) {
                  // Exigir conta ativa para seguir canais
                  if (!currentUser) {
                      alert('Você precisa ter uma conta e estar logado para seguir canais.');
                      openModal('loginModal');
                      return;
                  }

                  if (followingChannels.includes(channelName)) {
                      followingChannels = followingChannels.filter(c => c !== channelName);
                  } else {
                      followingChannels.push(channelName);
                  }
                  localStorage.setItem('streamify_following', JSON.stringify(followingChannels));
                  loadVideos();
              }

              async function loadVideos() {
                  const grid = document.getElementById('videoGrid');
                  try {
                      const res = await fetch('/api/videos');
                      const videos = await res.json();
                      
                      if(videos.length === 0) {
                          grid.innerHTML = '<p style="color: #777; grid-column: 1/-1; text-align: center; padding: 40px;">Nenhum vídeo postado ainda.</p>';
                          return;
                      }

                      grid.innerHTML = videos.map(v => {
                          const isFollowing = followingChannels.includes(v.channel_name);
                          return \`
                              <div class="card">
                                  <div class="video-wrapper">
                                      <iframe src="\${v.video_url}" sandbox="allow-scripts allow-same-origin allow-presentation" allowfullscreen></iframe>
                                  </div>
                                  <div class="card-info">
                                      <div class="card-title">\${v.title}</div>
                                      <div class="card-meta-row">
                                          <div class="card-channel">
                                              <span>\${v.channel_name}</span>
                                              <button class="btn-follow \${isFollowing ? 'following' : ''}" onclick="toggleFollow('\${v.channel_name}')">
                                                  \${isFollowing ? 'Seguindo' : 'Seguir'}
                                              </button>
                                          </div>
                                          <span style="font-size: 12px; color: #aaa;">👁️ \${v.views || 0} visualizações</span>
                                      </div>
                                      <div class="actions-row">
                                          <button class="btn-action" onclick="interact(\${v.id}, 'like')">👍 \${v.likes || 0}</button>
                                          <button class="btn-action" onclick="interact(\${v.id}, 'dislike')">👎 \${v.dislikes || 0}</button>
                                          <button class="btn-action" onclick="interact(\${v.id}, 'view')">🔄 Contabilizar View</button>
                                      </div>
                                  </div>
                              </div>
                          \`;
                      }).join('');
                  } catch (e) {
                      grid.innerHTML = '<p style="color: #777;">Erro ao carregar vídeos.</p>';
                  }
              }

              updateUI();
          </script>
      </body>
      </html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },
};
