const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

const REGIAO = "us-central1";

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
