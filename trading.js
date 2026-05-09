// trading.js - Order creation, signing, and submission to Polymarket CLOB

import { getSigner, getAddress } from './wallet.js';
import { authenticate, getAuthHeaders, isAuthenticated } from './auth.js';
import { state } from './js/state.js';

const CLOB_API_BASE = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

const ORDER_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CHAIN_ID
};

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' }
  ]
};

export async function placeBuyOrder(tokenId, price, size) {
  return placeOrder(tokenId, 'BUY', price, size);
}

export async function placeSellOrder(tokenId, price, size) {
  return placeOrder(tokenId, 'SELL', price, size);
}

async function placeOrder(tokenId, side, price, size) {
  try {
    if (!isAuthenticated()) {
      await authenticate();
    }

    const address = getAddress();
    if (!address) {
      throw new Error('Wallet not connected');
    }

    const order = buildOrder(tokenId, side, price, size, address);

    const signedOrder = await signOrder(order);

    const result = await submitOrder(signedOrder);

    return result;
  } catch (error) {
    console.error('Order placement failed:', error);
    throw error;
  }
}

function buildOrder(tokenId, side, price, size, makerAddress) {
  const salt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const nonce = Date.now();
  const expiration = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  const priceDecimal = parseFloat(price);
  const sizeDecimal = parseFloat(size);

  let makerAmount, takerAmount;

  if (side === 'BUY') {
    makerAmount = Math.floor(sizeDecimal * 1e6);
    takerAmount = Math.floor((sizeDecimal / priceDecimal) * 1e6);
  } else {
    makerAmount = Math.floor((sizeDecimal / priceDecimal) * 1e6);
    takerAmount = Math.floor(sizeDecimal * 1e6);
  }

  return {
    salt: salt.toString(),
    maker: makerAddress,
    signer: makerAddress,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: tokenId.toString(),
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration: expiration.toString(),
    nonce: nonce.toString(),
    feeRateBps: '0',
    side: side === 'BUY' ? 0 : 1,
    signatureType: 0
  };
}

async function signOrder(order) {
  try {
    const signer = getSigner();

    const signature = await signer.signTypedData(
      ORDER_DOMAIN,
      ORDER_TYPES,
      order
    );

    return {
      ...order,
      signature
    };
  } catch (error) {
    console.error('Order signing failed:', error);
    throw error;
  }
}

async function submitOrder(signedOrder) {
  try {
    const headers = getAuthHeaders();

    const orderPayload = {
      order: signedOrder,
      orderType: 'FOK',
      owner: signedOrder.maker
    };

    const response = await fetch(`${CLOB_API_BASE}/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(orderPayload)
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      let errorData = {};
      try {
        errorData = responseText ? JSON.parse(responseText) : {};
      } catch {
        errorData = {};
      }

      const parts = [];
      if (errorData?.error) parts.push(String(errorData.error));
      if (errorData?.message) parts.push(String(errorData.message));
      if (responseText && !parts.length) parts.push(responseText.slice(0, 500));

      const detail = parts.length ? ` - ${parts.join(' | ')}` : '';
      throw new Error(`Order submission failed: ${response.status} ${response.statusText}${detail}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Order submission failed:', error);
    throw error;
  }
}

export function getOrderStatus(orderId) {
  return fetch(`${CLOB_API_BASE}/orders/${orderId}`, {
    headers: getAuthHeaders()
  }).then(res => res.json());
}

export function cancelOrder(orderId) {
  return fetch(`${CLOB_API_BASE}/orders/${orderId}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  }).then(res => res.json());
}
