# -*- coding: utf-8 -*-
from odoo import models, fields

class MailCannedResponse(models.Model):
    _inherit = 'mail.canned.response'

    substitution = fields.Html(
        "Substitution",
        required=True,
        help="Content that will automatically replace the shortcut of your choosing. This content can still be adapted before sending your message.",
        sanitize=False,
    )

    usage_type = fields.Selection([
        ('all', 'Both'),
        ('message', 'Send Message'),
        ('note', 'Log Note'),
    ], string="Usage", default='all', required=True)

    def _to_store(self, store, /, *, fields=None):
        if fields is None:
            fields = ["source", "substitution", "usage_type"]
        elif "usage_type" not in fields:
            fields.append("usage_type")
        return super()._to_store(store, fields=fields)
