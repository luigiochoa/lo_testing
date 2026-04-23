# -*- coding: utf-8 -*-
from odoo import fields, models, api


class MailMessage(models.Model):
    _inherit = 'mail.message'

    pinned_at = fields.Datetime("Pinned At")

    def rt_toggle_pinned(self):
        """Toggle pinned state for a chatter message (Rich Text Chatter Pro)."""
        self.ensure_one()
        self.check_access('write')
        new_pinned_at = fields.Datetime.now() if not self.pinned_at else False
        self.write({'pinned_at': new_pinned_at})
        return {'pinned_at': self.pinned_at and str(self.pinned_at) or False}
