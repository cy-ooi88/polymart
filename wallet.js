// wallet.js - Web3 wallet connection and management

import { state } from './js/state.js';

let provider = null;
let signer = null;

export async function connectWallet() {
  try {
    if (typeof window.ethereum === 'undefined') {
      throw new Error('MetaMask or compatible wallet not detected. Please install MetaMask.');
    }

    provider = new ethers.BrowserProvider(window.ethereum);

    const accounts = await provider.send('eth_requestAccounts', []);

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts found. Please unlock your wallet.');
    }

    signer = await provider.getSigner();
    const address = await signer.getAddress();

    state.walletAddress = address;
    state.walletConnected = true;

    setupAccountChangeListener();

    return address;
  } catch (error) {
    console.error('Wallet connection failed:', error);
    state.walletConnected = false;
    state.walletAddress = null;
    throw error;
  }
}

export function disconnectWallet() {
  // Remove event listeners to prevent memory leaks
  if (window.ethereum && window.ethereum.removeAllListeners) {
    window.ethereum.removeAllListeners('accountsChanged');
    window.ethereum.removeAllListeners('chainChanged');
  }

  provider = null;
  signer = null;
  state.walletAddress = null;
  state.walletConnected = false;
  state.authCredentials = null;

  // Note: Web3 wallets don't provide a programmatic way to fully disconnect.
  // The user must manually disconnect from their wallet extension.
  // This function clears the app's connection state.
}

export function getAddress() {
  return state.walletAddress;
}

export function getSigner() {
  if (!signer) {
    throw new Error('Wallet not connected. Please connect your wallet first.');
  }
  return signer;
}

export function getProvider() {
  if (!provider) {
    throw new Error('Wallet not connected. Please connect your wallet first.');
  }
  return provider;
}

export function isConnected() {
  return state.walletConnected && state.walletAddress !== null;
}

function setupAccountChangeListener() {
  if (window.ethereum) {
    window.ethereum.on('accountsChanged', async (accounts) => {
      if (accounts.length === 0) {
        disconnectWallet();
      } else {
        try {
          signer = await provider.getSigner();
          const address = await signer.getAddress();
          state.walletAddress = address;
          state.authCredentials = null;
        } catch (error) {
          console.error('Error handling account change:', error);
          disconnectWallet();
        }
      }
    });

    window.ethereum.on('chainChanged', () => {
      window.location.reload();
    });
  }
}
