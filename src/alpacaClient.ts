import Alpaca from '@alpacahq/alpaca-trade-api';
import config from './config';

/**
 * Shared Alpaca client singleton — single configuration point for the entire bot.
 * All modules import this instance; never instantiate Alpaca directly elsewhere.
 */
const alpaca = new Alpaca({
  keyId:     config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  baseUrl:   config.alpaca.baseUrl,
  paper:     config.alpaca.paper,
});

export default alpaca;
