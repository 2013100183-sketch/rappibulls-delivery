
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  },
  body: JSON.stringify(data)
});

const token = () => randomBytes(32).toString('hex');

const stages = [
  'Asignado / pendiente de aceptación',
  'Pedido aceptado',
  'En camino al local',
  'Esperando pedido',
  'En camino a casa del cliente',
  'Pedido entregado'
];

const safe = e => ({
  message: e?.message || String(e)
});

const required = (x, n = 2000) =>
  String(x ?? '').trim().slice(0, n);

const isUuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const cents = x => {
  const v = Number(x);
  if (!Number.isFinite(v) || v < 0 || v > 100000) {
    return null;
  }
  return Math.round(v * 100);
};

const supa = () => {
  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw Error(
      'Faltan variables SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Netlify'
    );
  }

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
};

const checked = res => {
  if (res.error) throw res.error;
  return res.data;
};

const publicOrder = o => ({
  id: o.id,
  code: o.code,
  local: o.local_name,
  products: o.products,
  address: o.address,
  reference: o.reference,
  notes: o.notes,
  productAmount: o.product_cents / 100,
  deliveryAmount: o.delivery_cents / 100,
  etaMinutes: o.eta_minutes,
  etaUpdatedAt: o.eta_updated_at,
  stage: o.stage,
  rejected: o.rejected,
  cancelled: o.cancelled,
  updated: o.updated_at,
  riderName: o.riders?.name || ''
});

async function operator(db, headers) {
  const auth =
    headers.authorization ||
    headers.Authorization ||
    '';

  if (!auth.startsWith('Bearer ')) {
    throw Error('Inicia sesión como operadora');
  }

  const { data, error } = await db.auth.getUser(
    auth.slice(7)
  );

  if (error || !data.user) {
    throw Error('Sesión inválida');
  }

  const emails = (
    process.env.OPERATOR_EMAILS || ''
  )
    .toLowerCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (
    !emails.length ||
    !emails.includes((data.user.email || '').toLowerCase())
  ) {
    throw Error('Usuario no autorizado como operadora');
  }

  return data.user;
}

async function history(db, id, event) {
  checked(
    await db.from('order_history').insert({
      order_id: id,
      event
    })
  );
}

async function rotate(db, rider) {
  const top = checked(
    await db
      .from('riders')
      .select('queue_position')
      .order('queue_position', { ascending: false })
      .limit(1)
  );

  checked(
    await db
      .from('riders')
      .update({
        queue_position: (top[0]?.queue_position || 0) + 1
      })
      .eq('id', rider)
  );
}

async function loadOrder(db, id) {
  const rows = checked(
    await db
      .from('orders')
      .select('*,riders(name,token)')
      .eq('id', id)
      .limit(1)
  );

  if (!rows.length) {
    throw Error('Pedido no encontrado');
  }

  return rows[0];
}

async function timeout(db) {
  const now = new Date().toISOString();

  const expired = checked(
    await db
      .from('orders')
      .select('*')
      .eq('stage', 0)
      .eq('cancelled', false)
      .eq('rejected', false)
      .not('response_deadline', 'is', null)
      .lte('response_deadline', now)
  );

  for (const o of expired) {
    const updated = checked(
      await db
        .from('orders')
        .update({
          rejected: true,
          updated_at: now,
          response_deadline: null
        })
        .eq('id', o.id)
        .eq('stage', 0)
        .eq('rejected', false)
        .select('id')
    );

    if (updated.length) {
      if (o.assignment === 'turno') {
        await rotate(db, o.rider_id);
      }

      await history(
        db,
        o.id,
        'No respondió en 2 minutos'
      );
    }
  }
}

export async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return json(200, {});
    }

    if (event.httpMethod !== 'POST') {
      return json(405, {
        error: 'Método no permitido'
      });
    }

    const body = JSON.parse(event.body || '{}');
    const action = required(body.action, 60);
    const db = supa();

    // CONFIGURACIÓN PÚBLICA
    if (action === 'config') {
      return json(200, {
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY || ''
      });
    }

    // VISTA DEL MOTORIZADO
    if (action === 'rider_view') {
      const t = required(body.token, 100);

      if (!/^[a-f0-9]{64}$/.test(t)) {
        return json(403, {
          error: 'Enlace inválido'
        });
      }

      const rr = checked(
        await db
          .from('riders')
          .select('id,name,active')
          .eq('token', t)
          .limit(1)
      );

      if (!rr.length) {
        return json(404, {
          error: 'Motorizado no encontrado'
        });
      }

      await timeout(db);

      const os = checked(
        await db
          .from('orders')
          .select('*')
          .eq('rider_id', rr[0].id)
          .order('created_at', { ascending: false })
          .limit(80)
      );

      return json(200, {
        rider: rr[0],
        orders: os.map(o => ({
          ...publicOrder(o),
          phone: o.phone,
          instructions: o.instructions,
          map: o.map_url,
          payment: o.payment,
          clientToken: o.client_token
        }))
      });
    }

    // VISTA DEL CLIENTE
    if (action === 'client_view') {
      const t = required(body.token, 100);

      if (!/^[a-f0-9]{64}$/.test(t)) {
        return json(403, {
          error: 'Enlace inválido'
        });
      }

      const os = checked(
        await db
          .from('orders')
          .select('*,riders(name)')
          .eq('client_token', t)
          .limit(1)
      );

      if (!os.length) {
        return json(404, {
          error: 'Pedido no encontrado'
        });
      }

      return json(200, {
        order: publicOrder(os[0])
      });
    }

    // ACTUALIZACIONES DEL MOTORIZADO
    if (action === 'rider_update') {
      const t = required(body.token, 100);
      const id = required(body.id, 100);
      const choice = required(body.choice, 40);

      if (!/^[a-f0-9]{64}$/.test(t)) {
        return json(403, {
          error: 'Enlace inválido'
        });
      }

      const rr = checked(
        await db
          .from('riders')
          .select('id')
          .eq('token', t)
          .limit(1)
      );

      if (!rr.length) {
        return json(403, {
          error: 'Acceso denegado'
        });
      }

      const o = await loadOrder(db, id);

      if (
        o.rider_id !== rr[0].id ||
        o.cancelled ||
        o.rejected ||
        o.stage === 5
      ) {
        throw Error('Pedido no disponible');
      }

      const now = new Date().toISOString();

      if (choice === 'reject') {
        if (o.stage !== 0) {
          throw Error(
            'Solo puedes rechazar antes de aceptar'
          );
        }

        const rows = checked(
          await db
            .from('orders')
            .update({
              rejected: true,
              updated_at: now,
              response_deadline: null
            })
            .eq('id', id)
            .eq('stage', 0)
            .eq('rejected', false)
            .select('id')
        );

        if (!rows.length) {
          throw Error('Pedido ya respondido');
        }

        if (o.assignment === 'turno') {
          await rotate(db, o.rider_id);
        }

        await history(db, id, 'Pedido rechazado');

      } else {
        const next = Number(body.stage);

        if (
          !Number.isInteger(next) ||
          next !== o.stage + 1 ||
          next > 5
        ) {
          throw Error(
            'Avanza los estados en orden'
          );
        }

        if (
          o.stage === 0 &&
          o.response_deadline &&
          new Date(o.response_deadline).getTime() < Date.now()
        ) {
          throw Error(
            'Plazo de aceptación vencido'
          );
        }

        const rows = checked(
          await db
            .from('orders')
            .update({
              stage: next,
              updated_at: now,
              response_deadline: null
            })
            .eq('id', id)
            .eq('stage', o.stage)
            .eq('rejected', false)
            .eq('cancelled', false)
            .select('id')
        );

        if (!rows.length) {
          throw Error(
            'Estado modificado por otro dispositivo'
          );
        }

        if (
          next === 1 &&
          o.assignment === 'turno'
        ) {
          await rotate(db, o.rider_id);
        }

        await history(db, id, stages[next]);
      }

      return json(200, { ok: true });
    }

    // VERIFICAR OPERADORA
    await operator(db, event.headers || {});

    // LISTAR MOTORIZADOS Y PEDIDOS
    if (action === 'list') {
      await timeout(db);

      const rs = checked(
        await db
          .from('riders')
          .select('*')
          .order('queue_position', { ascending: true })
      );

      const os = checked(
        await db
          .from('orders')
          .select('*,riders(name,token)')
          .order('created_at', { ascending: false })
          .limit(300)
      );

      return json(200, {
        riders: rs.map(r => ({
          id: r.id,
          name: r.name,
          active: r.active,
          token: r.token,
          busy: os.some(
            o =>
              o.rider_id === r.id &&
              o.stage >= 1 &&
              o.stage < 5 &&
              !o.cancelled &&
              !o.rejected
          ),
          pending: os.some(
            o =>
              o.rider_id === r.id &&
              o.stage === 0 &&
              !o.cancelled &&
              !o.rejected
          )
        })),
        orders: os.map(o => ({
          ...publicOrder(o),
          phone: o.phone,
          instructions: o.instructions,
          map: o.map_url,
          payment: o.payment,
          raw: o.raw_message,
          assignment: o.assignment,
          reason: o.reason,
          riderId: o.rider_id,
          riderToken: o.riders?.token,
          clientToken: o.client_token,
          sentAt: o.sent_at,
          deadline: o.response_deadline
        }))
      });
    }

    // REGISTRAR MOTORIZADO
    if (action === 'add_rider') {
      const name = required(body.name, 100);

      if (name.length < 2) {
        throw Error('Nombre demasiado corto');
      }

      const max = checked(
        await db
          .from('riders')
          .select('queue_position')
          .order('queue_position', { ascending: false })
          .limit(1)
      );

      checked(
        await db.from('riders').insert({
          name,
          token: token(),
          queue_position:
            (max[0]?.queue_position || 0) + 1
        })
      );

      return json(200, { ok: true });
    }

    // ACTIVAR O PAUSAR MOTORIZADO
    if (action === 'toggle_rider') {
      const r = checked(
        await db
          .from('riders')
          .select('active')
          .eq('id', body.id)
          .single()
      );

      checked(
        await db
          .from('riders')
          .update({ active: !r.active })
          .eq('id', body.id)
      );

      return json(200, { ok: true });
    }

    // =====================================
    // CREAR PEDIDO - UUID CORREGIDO
    // =====================================
    if (action === 'create') {
      const local = required(body.local, 300);
      const products = required(body.products, 5000);
      const address = required(body.address, 500);

      // Compatible con central.js.
      const riderId = required(
        body.riderId || body.rider,
        80
      );

      const assignment =
        body.assignment === 'manual'
          ? 'manual'
          : 'turno';

      const reason = required(body.reason, 500);

      if (!local || !products || !address) {
        throw Error(
          'Completa local, productos y dirección'
        );
      }

      if (!isUuid(riderId)) {
        throw Error(
          'Selecciona un motorizado válido antes de crear el pedido.'
        );
      }

      if (
        assignment === 'manual' &&
        !reason
      ) {
        throw Error(
          'La asignación manual requiere justificación'
        );
      }

      const riders = checked(
        await db
          .from('riders')
          .select('*')
          .eq('id', riderId)
          .eq('active', true)
          .limit(1)
      );

      const r = riders[0];

      if (!r) {
        throw Error(
          'Motorizado no disponible'
        );
      }

      const pending = checked(
        await db
          .from('orders')
          .select('id')
          .eq('rider_id', riderId)
          .eq('stage', 0)
          .eq('cancelled', false)
          .eq('rejected', false)
          .limit(1)
      );

      if (pending.length) {
        throw Error(
          'El motorizado ya tiene una solicitud pendiente de respuesta'
        );
      }

      if (assignment === 'turno') {
        const busy = checked(
          await db
            .from('orders')
            .select('id')
            .eq('rider_id', riderId)
            .gte('stage', 1)
            .lt('stage', 5)
            .eq('cancelled', false)
            .eq('rejected', false)
            .limit(1)
        );

        if (busy.length) {
          throw Error(
            'Motorizado ocupado: usa asignación manual justificada'
          );
        }
      }

      const p = cents(body.productAmount);
      const d = cents(body.deliveryAmount);

      if (p === null || d === null) {
        throw Error('Importes inválidos');
      }

      const eta =
        body.etaMinutes === '' ||
        body.etaMinutes == null
          ? null
          : Number(body.etaMinutes);

      if (
        eta !== null &&
        (
          !Number.isInteger(eta) ||
          eta < 1 ||
          eta > 360
        )
      ) {
        throw Error(
          'ETA debe ser 1 a 360 minutos'
        );
      }

      const code =
        'RB-' +
        Date.now().toString(36).toUpperCase() +
        randomBytes(2).toString('hex').toUpperCase();

      const o = checked(
        await db
          .from('orders')
          .insert({
            code,
            local_name: local,
            products,
            address,
            rider_id: riderId,
            client_token: token(),
            assignment,
            reason,
            phone: required(body.phone, 100),
            instructions: required(
              body.instructions,
              2000
            ),
            reference: required(
              body.reference,
              500
            ),
            map_url: required(body.map, 1000),
            notes: required(body.notes, 2000),
            payment: required(body.payment, 200),
            raw_message: required(
              body.raw,
              10000
            ),
            product_cents: p,
            delivery_cents: d,
            eta_minutes: eta,
            eta_updated_at: eta
              ? new Date().toISOString()
              : null
          })
          .select('id')
          .single()
      );

      await history(db, o.id, 'Pedido creado');

      return json(200, { ok: true });
    }

    // CONFIRMAR ENVÍO DE WHATSAPP
    if (action === 'mark_sent') {
      const o = await loadOrder(db, body.id);

      if (
        o.stage !== 0 ||
        o.rejected ||
        o.cancelled
      ) {
        throw Error('Pedido ya respondido');
      }

      const now = new Date();

      checked(
        await db
          .from('orders')
          .update({
            sent_at: now.toISOString(),
            response_deadline:
              new Date(
                now.getTime() + 120000
              ).toISOString(),
            updated_at: now.toISOString()
          })
          .eq('id', o.id)
      );

      await history(
        db,
        o.id,
        'Operadora confirmó envío de WhatsApp; plazo 2 minutos'
      );

      return json(200, { ok: true });
    }

    // ACTUALIZAR IMPORTES
    if (action === 'prices') {
      const p = cents(body.productAmount);
      const d = cents(body.deliveryAmount);

      if (p === null || d === null) {
        throw Error('Importes inválidos');
      }

      checked(
        await db
          .from('orders')
          .update({
            product_cents: p,
            delivery_cents: d,
            updated_at: new Date().toISOString()
          })
          .eq('id', body.id)
      );

      await history(
        db,
        body.id,
        'Importes actualizados'
      );

      return json(200, { ok: true });
    }

    // ACTUALIZAR TIEMPO ESTIMADO
    if (action === 'eta') {
      const v =
        body.etaMinutes === '' ||
        body.etaMinutes == null
          ? null
          : Number(body.etaMinutes);

      if (
        v !== null &&
        (
          !Number.isInteger(v) ||
          v < 1 ||
          v > 360
        )
      ) {
        throw Error(
          'Tiempo estimado inválido'
        );
      }

      checked(
        await db
          .from('orders')
          .update({
            eta_minutes: v,
            eta_updated_at:
              new Date().toISOString(),
            updated_at:
              new Date().toISOString()
          })
          .eq('id', body.id)
      );

      return json(200, { ok: true });
    }

    // CANCELAR PEDIDO
    if (action === 'cancel') {
      checked(
        await db
          .from('orders')
          .update({
            cancelled: true,
            updated_at:
              new Date().toISOString()
          })
          .eq('id', body.id)
          .neq('stage', 5)
      );

      await history(
        db,
        body.id,
        'Pedido cancelado'
      );

      return json(200, { ok: true });
    }

    return json(400, {
      error: 'Acción no reconocida'
    });

  } catch (e) {
    const msg = safe(e).message;

    return json(
      /autorizad|Sesión|Inicia sesión|Acceso denegado/.test(msg)
        ? 403
        : 400,
      { error: msg }
    );
  }
}
