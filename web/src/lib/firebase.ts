import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

export const usingEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

// Public web config (safe to ship; access is controlled by security rules).
const firebaseConfig = {
  apiKey: 'AIzaSyB-8AmUdYHW6-UVc0ax09K9nuxI4x11iRs',
  authDomain: 'australiadrivingproj.firebaseapp.com',
  // Emulators run under a demo project so tests can never touch production data.
  projectId: usingEmulators ? 'demo-safelearners' : 'australiadrivingproj',
  storageBucket: 'australiadrivingproj.firebasestorage.app',
  messagingSenderId: '906653434498',
  appId: '1:906653434498:web:6f382d3c20113e0966ea9b',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const storage = getStorage(app);
export const functions = getFunctions(app, 'australia-southeast1');

if (usingEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}
