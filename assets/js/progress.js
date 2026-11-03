import { getDb, getAuthInstance, isReady } from "./auth.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export async function getLessonProgress(lessonId) {
  const auth = getAuthInstance();
  if (!isReady() || !auth?.currentUser) return {};
  const ref = doc(getDb(), "users", auth.currentUser.uid, "progress", lessonId);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data().sections || {} : {};
}
