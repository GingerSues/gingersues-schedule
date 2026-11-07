// The Firebase SDK pieces the app uses. Tests swap this file for test/fake-fbapi.js.
export { initializeApp } from "firebase/app";
export {
  getAuth, onAuthStateChanged, signInWithPhoneNumber, RecaptchaVerifier, signOut,
} from "firebase/auth";
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, orderBy, limit, onSnapshot,
  setDoc, updateDoc, deleteDoc, getDoc, getDocs, writeBatch, deleteField,
} from "firebase/firestore";
export { getFunctions, httpsCallable } from "firebase/functions";

export async function loadConfig() {
  const r = await fetch("/__/firebase/init.json");
  if (!r.ok) throw new Error("Firebase config not found");
  return r.json();
}
