// Memorial Newton Faro Guimarães — Worker Cloudflare
// Serve a API de dados compartilhados com banco D1

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
};

const j = (data, s=200) => new Response(JSON.stringify(data), {
  status: s, headers: {...CORS, 'Content-Type': 'application/json'}
});

const isAdmin = (req, env) =>
  req.headers.get('X-Admin-Key') === (env.ADMIN_KEY || '193117');

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {headers: CORS});

    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = `${url.protocol}//${url.host}`;
    const db = env.DB;

    // ── ROBOTS.TXT ── (sem banco necessário)
    if (path === '/robots.txt') {
      return new Response(
        `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`,
        { headers: { 'Content-Type': 'text/plain', ...CORS } }
      );
    }

    // ── SITEMAP.XML ── (sem banco necessário)
    if (path === '/sitemap.xml') {
      const today = new Date().toISOString().split('T')[0];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="pt-BR" href="${baseUrl}/"/>
  </url>
</urlset>`;
      return new Response(xml, {
        headers: { 'Content-Type': 'application/xml; charset=UTF-8', ...CORS }
      });
    }

    // Se não há banco, retornar dados padrão
    if (!db) return j({error: 'Database not configured'}, 503);

    try {
      // ── GET /all ── (carregamento inicial de tudo)
      if (path === '/all' && request.method === 'GET') {
        const now = Date.now();
        const [settings, candles, photos, stories, media, homenagens] = await Promise.all([
          db.prepare('SELECT key, value FROM settings').all(),
          db.prepare('SELECT * FROM candles WHERE expires > ? ORDER BY lit DESC').bind(now).all(),
          db.prepare('SELECT * FROM photos ORDER BY sort_order, id').all(),
          db.prepare('SELECT * FROM stories ORDER BY sort_order, id').all(),
          db.prepare('SELECT * FROM media ORDER BY sort_order, id').all(),
          db.prepare('SELECT * FROM homenagens ORDER BY sort_order, id').all(),
        ]);
        const settingsObj = {};
        for (const row of settings.results) {
          try { settingsObj[row.key] = JSON.parse(row.value); }
          catch { settingsObj[row.key] = row.value; }
        }
        return j({
          ...settingsObj,
          candles: candles.results,
          photos: photos.results.map(p=>({id:p.id,url:p.url,key:p.idb_key,caption:p.caption})),
          stories: stories.results.map(s=>({id:s.id,cloudId:s.id,title:s.title,date:s.date_tag,body:s.body,audioUrl:s.audio_url})),
          media: media.results.map(m=>({id:m.id,cloudId:m.id,type:m.type,title:m.title,url:m.url,desc:m.description})),
          homenagens: homenagens.results.map(h=>({id:h.id,cloudId:h.id,name:h.name,relation:h.relation,text:h.body,avatarUrl:h.avatar_url,avatarKey:h.idb_key,videoUrl:h.video_url,audioUrl:h.audio_url,date:h.created_at})),
        });
      }

      // ── POST /save ── (salvar settings: hero, bio, footer, audios)
      if (path === '/save' && request.method === 'POST') {
        if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
        const body = await request.json();
        if (body.section === 'settings' && body.data) {
          for (const [key, val] of Object.entries(body.data)) {
            await db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
              .bind(key, JSON.stringify(val)).run();
          }
        }
        return j({ok: true});
      }

      // ── CANDLES ──
      if (path === '/candles') {
        if (request.method === 'GET') {
          const now = Date.now();
          const {results} = await db.prepare('SELECT * FROM candles WHERE expires > ? ORDER BY lit DESC').bind(now).all();
          return j(results);
        }
        if (request.method === 'POST') {
          const b = await request.json();
          await db.prepare('INSERT OR REPLACE INTO candles (id,name,msg,lit,expires) VALUES (?,?,?,?,?)')
            .bind(b.id, b.name, b.msg||'', b.lit, b.expires).run();
          return j({ok:true});
        }
      }
      if (path.startsWith('/candles/') && request.method === 'DELETE') {
        if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
        const id = path.split('/')[2];
        await db.prepare('DELETE FROM candles WHERE id=?').bind(id).run();
        return j({ok:true});
      }

      // ── PHOTOS ──
      if (path === '/photos') {
        if (request.method === 'POST') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          const b = await request.json();
          const {meta} = await db.prepare('INSERT INTO photos (url,idb_key,caption) VALUES (?,?,?)')
            .bind(b.url||'', b.idb_key||'', b.caption||'').run();
          return j({ok:true, id:meta.last_row_id});
        }
      }
      if (path.startsWith('/photos/')) {
        const id = path.split('/')[2];
        if (request.method === 'PUT') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          const b = await request.json();
          await db.prepare('UPDATE photos SET url=?,caption=? WHERE id=?').bind(b.url||'',b.caption||'',id).run();
          return j({ok:true});
        }
        if (request.method === 'DELETE') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          await db.prepare('DELETE FROM photos WHERE id=?').bind(id).run();
          return j({ok:true});
        }
      }

      // ── STORIES ──
      if (path === '/stories' && request.method === 'POST') {
        if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
        const b = await request.json();
        const {meta} = await db.prepare('INSERT INTO stories (title,date_tag,body,audio_url) VALUES (?,?,?,?)')
          .bind(b.title,b.date_tag||'',b.body,b.audio_url||'').run();
        return j({ok:true, id:meta.last_row_id});
      }
      if (path.startsWith('/stories/')) {
        const id = path.split('/')[2];
        if (request.method === 'PUT') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          const b = await request.json();
          await db.prepare('UPDATE stories SET title=?,date_tag=?,body=?,audio_url=? WHERE id=?')
            .bind(b.title,b.date_tag||'',b.body,b.audio_url||'',id).run();
          return j({ok:true});
        }
        if (request.method === 'DELETE') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          await db.prepare('DELETE FROM stories WHERE id=?').bind(id).run();
          return j({ok:true});
        }
      }

      // ── MEDIA ──
      if (path === '/media' && request.method === 'POST') {
        if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
        const b = await request.json();
        const {meta} = await db.prepare('INSERT INTO media (type,title,url,description) VALUES (?,?,?,?)')
          .bind(b.type,b.title,b.url,b.description||'').run();
        return j({ok:true, id:meta.last_row_id});
      }
      if (path.startsWith('/media/') && request.method === 'DELETE') {
        if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
        const id = path.split('/')[2];
        await db.prepare('DELETE FROM media WHERE id=?').bind(id).run();
        return j({ok:true});
      }

      // ── HOMENAGENS ──
      if (path === '/homenagens' && request.method === 'POST') {
        if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
        const b = await request.json();
        const {meta} = await db.prepare('INSERT INTO homenagens (name,relation,body,avatar_url,idb_key,video_url,audio_url) VALUES (?,?,?,?,?,?,?)')
          .bind(b.name,b.relation||'',b.body||'',b.avatar_url||'',b.idb_key||'',b.video_url||'',b.audio_url||'').run();
        return j({ok:true, id:meta.last_row_id});
      }
      if (path.startsWith('/homenagens/')) {
        const id = path.split('/')[2];
        if (request.method === 'PUT') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          const b = await request.json();
          await db.prepare('UPDATE homenagens SET name=?,relation=?,body=?,avatar_url=?,video_url=?,audio_url=? WHERE id=?')
            .bind(b.name,b.relation||'',b.body||'',b.avatar_url||'',b.video_url||'',b.audio_url||'',id).run();
          return j({ok:true});
        }
        if (request.method === 'DELETE') {
          if (!isAdmin(request, env)) return j({error:'Unauthorized'}, 401);
          await db.prepare('DELETE FROM homenagens WHERE id=?').bind(id).run();
          return j({ok:true});
        }
      }

      return j({error:'Not found'}, 404);
    } catch(e) {
      return j({error: e.message}, 500);
    }
  }
};
