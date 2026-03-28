import { Router, Request, Response } from 'express';
import {
  getAccountDetails,
  getAccountTransactions,
} from '../services/horizon';

const router = Router();

// GET /api/account/:address
router.get('/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string;
    const account = await getAccountDetails(address);
    if (!account) {
      return res.status(404).json({ error: 'Account not found or not funded' });
    }
    res.json(account);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/account/:address/transactions
router.get('/:address/transactions', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 200);
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
