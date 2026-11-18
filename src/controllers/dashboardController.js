import { asyncHandler } from '../utils/errors.js';
import { dashboardFor } from '../services/dashboardService.js';

/**
 * One endpoint per role. The route middleware already guarantees the caller's role,
 * and the service scopes every query to that role — the role is never taken from
 * the request body or a query string.
 */
export function dashboard(role) {
  return asyncHandler(async (req, res) => {
    if (req.user.role !== role) {
      return res.status(403).json({
        success: false,
        error: { code: 'ROLE_FORBIDDEN', message: 'This dashboard belongs to another role.' },
      });
    }
    const data = await dashboardFor(req.user, { childId: req.query.childId });
    return res.json({ success: true, data });
  });
}

export default { dashboard };
