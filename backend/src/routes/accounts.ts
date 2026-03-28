import { Router, Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import {
  getAccountDetails,
  getAccountTransactions,
} from '../services/horizon';

const router = Router();

function validateAddress(req: Request, res: Response, next: NextFunction): void {
  try {
    Keypair.fromPublicKey(req.params.address as string);
    next();
  } catch {
    res.status(400).json({ error: 'Invalid Stellar address' });
  }
}

// GET /api/account/:address
router.get('/:address', validateAddress, async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string;
    const account = await getAccountDetails(address);
    if (!account) {
      return res.status(404).json({ error: 'Account not found or not funded' });
    }
    res.json(account);
  } catch (err: any) {
    const response: Record<string, string> = {
      error: 'Failed to fetch account details',
    };
    if (process.env.NODE_ENV === 'development') {
      response.details = err.message;
    }
    res.status(500).json(response);
  }
});

// GET /api/account/:address/transactions
router.get('/:address/transactions', validateAddress, async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string;
    const parsed = parseInt(req.query.limit as string);
    const limit = Number.isNaN(parsed) ? 20 : Math.min(parsed, 200);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const order = req.query.order === 'asc' ? 'asc' : 'desc';

    const result = await getAccountTransactions(address, limit, cursor, order);
    const transactions = result.records;
    const nextCursor =
      transactions.length === limit
        ? transactions[transactions.length - 1]?.paging_token ?? null
        : null;

    res.json({
      transactions,
      count: transactions.length,
      cursor: {
        current: cursor ?? null,
        next: nextCursor,
      },
      order,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
