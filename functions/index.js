const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

const REGIAO = "us-central1";

// Notificações automáticas por email — assumem que existe uma coleção
// "mail" ligada à extensão oficial do Firebase "Trigger Email" (escrever lá
// um documento é o que dispara o envio a sério; estas functions nunca
// falam diretamente com um servidor de email).
async function obterEmailsAdmins(db) {
  const snap = await db.collection("psicologos").where("role", "==", "admin").get();
  return snap.docs.map(d => d.data().email).filter(Boolean);
}

// Apaga por completo um psicólogo: o perfil na Firestore (psicologos/{uid})
// e, já que isto corre com privilégios de administrador no servidor, também
// a conta de login em Authentication — o que o painel (admin.html), a
// correr no browser do cliente, não tem permissões para fazer sozinho.
exports.removerPsicologo = onCall({ region: REGIAO }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "É preciso ter sessão iniciada.");
  }

  const chamadorUid = request.auth.uid;
  const chamadorSnap = await admin.firestore().collection("psicologos").doc(chamadorUid).get();
  if (!chamadorSnap.exists || chamadorSnap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Só um administrador pode remover contas.");
  }

  const uid = request.data && request.data.uid;
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "UID em falta.");
  }
  if (uid === chamadorUid) {
    throw new HttpsError("failed-precondition", "Não podes remover a tua própria conta a partir daqui.");
  }

  await admin.firestore().collection("psicologos").doc(uid).delete();

  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    // Se a conta de login já não existir (ex: apagada antes à mão na
    // consola), não é um erro — o objetivo (não haver mais acesso) já
    // está cumprido.
    if (err.code !== "auth/user-not-found") {
      throw new HttpsError("internal", "O perfil foi apagado, mas falhou remover a conta de login: " + err.message);
    }
  }

  return { ok: true };
});

// Marca uma nova consulta para o mesmo cliente de uma consulta já existente
// (ex: "a próxima consulta deste paciente"), copiando o nome/email/telefone
// no servidor — assim, um psicólogo sem a permissão "Ver todas as
// consultas" consegue reagendar os seus próprios clientes sem o
// email/telefone deles alguma vez chegarem ao browser dele. Reserva a hora
// escolhida como uma operação atómica (tudo ou nada), tal como o site
// público.
exports.marcarProximaConsulta = onCall({ region: REGIAO }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "É preciso ter sessão iniciada.");
  }
  const chamadorUid = request.auth.uid;
  const db = admin.firestore();

  const chamadorSnap = await db.collection("psicologos").doc(chamadorUid).get();
  if (!chamadorSnap.exists) {
    throw new HttpsError("permission-denied", "Perfil não encontrado.");
  }
  const chamadorPerfil = chamadorSnap.data();
  const souAdmin = chamadorPerfil.role === "admin";
  const vejoTodasConsultas = souAdmin || !!(chamadorPerfil.permissoes && chamadorPerfil.permissoes.verTodasConsultas);

  const dados = request.data || {};
  const consultaOrigemId = dados.consultaOrigemId;
  const tipo = dados.tipo;
  const data = dados.data;
  const hora = dados.hora;
  let psicologoId = dados.psicologoId;
  let psicologoNome = dados.psicologoNome;

  if (!consultaOrigemId || !tipo || !data || !hora || !psicologoId) {
    throw new HttpsError("invalid-argument", "Faltam dados para marcar a consulta.");
  }

  const origemSnap = await db.collection("consultas").doc(consultaOrigemId).get();
  if (!origemSnap.exists) {
    throw new HttpsError("not-found", "Consulta de origem não encontrada.");
  }
  const origem = origemSnap.data();

  // Sem a permissão de ver todas as consultas, só pode reagendar um
  // cliente que já é seu, e só na própria agenda — nunca na de outro
  // psicólogo, mesmo que tente indicar outro psicologoId no pedido.
  if (!vejoTodasConsultas) {
    if (origem.psicologoId !== chamadorUid) {
      throw new HttpsError("permission-denied", "Só podes reagendar os teus próprios clientes.");
    }
    psicologoId = chamadorUid;
    psicologoNome = chamadorPerfil.nome || "";
  }

  const origemPrivadoSnap = await db.collection("consultas").doc(consultaOrigemId).collection("privado").doc("dados").get();
  const contacto = origemPrivadoSnap.exists ? origemPrivadoSnap.data() : {};

  const slotId = `${psicologoId}_${data}_${hora}`;
  const slotRef = db.collection("disponibilidade").doc(slotId);
  const novaConsultaRef = db.collection("consultas").doc();
  const novoPrivadoRef = novaConsultaRef.collection("privado").doc("dados");

  await db.runTransaction(async (tx) => {
    const slotSnap = await tx.get(slotRef);
    if (!slotSnap.exists || slotSnap.data().reservado) {
      throw new HttpsError("failed-precondition", "Essa hora já não está disponível.");
    }
    tx.set(novaConsultaRef, {
      clienteNome: origem.clienteNome || "",
      psicologoId,
      psicologoNome: psicologoNome || "",
      tipo,
      data,
      hora,
      estado: "confirmada",
      visualizada: false,
      notaInterna: "",
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(novoPrivadoRef, {
      clienteEmail: contacto.clienteEmail || "",
      clienteTelefone: contacto.clienteTelefone || "",
    });
    tx.update(slotRef, { reservado: true, consultaId: novaConsultaRef.id });
  });

  return { ok: true, novaConsultaId: novaConsultaRef.id };
});

// Dispara sempre que uma consulta é criada — seja pelo site público, pelo
// admin ("Marcar nova consulta"), ou pela function marcarProximaConsulta.
// Avisa o psicólogo atribuído, confirma ao cliente, e avisa os admins se
// for uma "Primeira consulta" (para a triagem não passar despercebida).
exports.notificarNovaConsulta = onDocumentCreated({ region: REGIAO, document: "consultas/{consultaId}" }, async (event) => {
  const db = admin.firestore();
  const c = event.data.data();
  const linhaDataHora = `${c.data || "-"} às ${c.hora || "-"}`;

  const privadoSnap = await event.data.ref.collection("privado").doc("dados").get();
  const contacto = privadoSnap.exists ? privadoSnap.data() : {};

  if (c.psicologoId) {
    const psicologoSnap = await db.collection("psicologos").doc(c.psicologoId).get();
    const perfilPsicologo = psicologoSnap.exists ? psicologoSnap.data() : {};
    if (perfilPsicologo.email) {
      await db.collection("mail").add({
        to: [perfilPsicologo.email],
        message: {
          subject: "Nova consulta atribuída — Essencialmente",
          text: `Olá ${perfilPsicologo.nome || ""},\n\nFoi-te atribuída uma nova consulta:\n\nCliente: ${c.clienteNome || "-"}\nTipo: ${c.tipo || "-"}\nData/Hora: ${linhaDataHora}\n\nConsulta o painel para mais detalhes.\n\n— Essencialmente`,
        },
      });
    }
  }

  if (contacto.clienteEmail) {
    await db.collection("mail").add({
      to: [contacto.clienteEmail],
      message: {
        subject: "A sua consulta foi marcada — Essencialmente",
        text: `Olá ${c.clienteNome || ""},\n\nA sua consulta (${c.tipo || "-"}) ficou marcada para ${linhaDataHora}.\n\nEntraremos em contacto para confirmar e enviar o link da videochamada.\n\n— Essencialmente`,
      },
    });
  }

  if (c.tipo === "Primeira consulta") {
    const emailsAdmins = await obterEmailsAdmins(db);
    if (emailsAdmins.length > 0) {
      await db.collection("mail").add({
        to: emailsAdmins,
        message: {
          subject: "Nova Primeira Consulta marcada — Essencialmente",
          text: `Uma nova "Primeira consulta" foi marcada.\n\nCliente: ${c.clienteNome || "-"}\nData/Hora: ${linhaDataHora}\n\nVai à aba Triagem para, mais tarde, atribuir um psicólogo de acompanhamento.`,
        },
      });
    }
  }
});

// Dispara sempre que chega um novo pedido de contacto na Lista de espera.
exports.notificarNovoPedidoEspera = onDocumentCreated({ region: REGIAO, document: "listaEspera/{itemId}" }, async (event) => {
  const db = admin.firestore();
  const p = event.data.data();

  const emailsAdmins = await obterEmailsAdmins(db);
  if (emailsAdmins.length === 0) return;

  await db.collection("mail").add({
    to: emailsAdmins,
    message: {
      subject: "Novo pedido de contacto — Essencialmente",
      text: `Novo pedido na Lista de espera:\n\nNome: ${p.clienteNome || "-"}\nEmail: ${p.clienteEmail || "-"}\nTelefone: ${p.clienteTelefone || "-"}\nNotas: ${p.notas || "-"}\n\nVai à aba Lista de espera para contactar.`,
    },
  });
});
