{
    'name': 'Rich Text Chatter.tool',
    'version': '18.0.1.0.0',
    'category': 'Productivity/Discuss',
    'summary': 'Full WYSIWYG editor for Chatter, Native DOCX/XLSX/PDF previews, Quote & Reply actions, and advanced Canned Responses.',
    'description': """
Rich Text Chatter Pro
=====================
Enhances the default Odoo Chatter Composer with a wealth of features:
- **WYSIWYG Rich Text Editor:** Use full formatting, commands (/), and mentions directly in the Chatter.
- **Native Document Previews:** View DOCX, XLSX, and PDF files natively in the browser without downloading.
- **Quote & Reply:** Easily quote historical messages with an integrated Quote button.
- **Multi-language Support:** Ready for English, Spanish, French, and Portuguese.
    """,
    'author': 'eightools',
    'website': 'https://www.eightools.com',
    'license': 'OPL-1',
    'price': 29.00,
    'currency': 'USD',
    'images': ['static/description/banner.png'],
    'depends': ['mail', 'html_editor'],
    'data': [
        'views/mail_canned_response_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'rich_text_chatter_18/static/src/xml/composer_patch.xml',
            'rich_text_chatter_18/static/src/xml/canned_response_list.xml',
            'rich_text_chatter_18/static/src/scss/rich_text_chatter.scss',
            'rich_text_chatter_18/static/src/js/canned_response_list.js',
            'rich_text_chatter_18/static/src/js/canned_response_plugin.js',
            'rich_text_chatter_18/static/src/js/composer_patch.js',
        ],
    },
    'installable': True,
    'application': False,
    'auto_install': False,
}
