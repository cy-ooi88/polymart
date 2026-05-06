// auth.js - Polymarket API authentication via EIP-712 signatures

import { getSigner, getAddress } from './wallet.js';
import { state } from './js/state.js';

const POLYMARKET_AUTH_DOMAIN = {
  name: 'Polymarket',
  version: '1',
  chainId: 137
};

export async function authenticate() {
  try {
    const signer = getSigner();
    const address = getAddress();

    if (!address) {
      throw new Error('Wallet not connected');
    }

    const timestamp = Date.now();
    const nonce = Math.floor(Math.random() * 1000000);

    const message = {
      timestamp,
      nonce
    };

    const types = {
      Auth: [
        { name: 'timestamp', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }
      ]
    };

    const signature = await signer.signTypedData(
      POLYMARKET_AUTH_DOMAIN,
      types,
      message
    );

    const credentials = {
      address,
      signature,
      timestamp,
      nonce,
      apiKey: generateApiKey(),
      passphrase: generatePassphrase()
    };

    state.authCredentials = credentials;

    return credentials;
  } catch (error) {
    console.error('Authentication failed:', error);
    throw error;
  }
}

export function getAuthHeaders() {
  if (!state.authCredentials) {
    throw new Error('Not authenticated. Please authenticate first.');
  }

  const { address, signature, apiKey, passphrase } = state.authCredentials;
  const timestamp = Date.now();

  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': signature,
    'POLY_API_KEY': apiKey,
    'POLY_PASSPHRASE': passphrase,
    'POLY_TIMESTAMP': timestamp.toString(),
    'Content-Type': 'application/json'
  };
}

export function isAuthenticated() {
  return state.authCredentials !== null;
}

export function clearAuth() {
  state.authCredentials = null;
}

function generateApiKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generatePassphrase() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
