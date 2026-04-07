/** @odoo-module */

import { Composer } from "@mail/core/common/composer";
import { Wysiwyg } from "@html_editor/wysiwyg";
import { patch } from "@web/core/utils/patch";
import { Store } from "@mail/core/common/store_service";
import { messageActionsRegistry } from "@mail/core/common/message_actions";
import { Message as MessageModel } from "@mail/core/common/message_model";
import { Message as MessageComponent } from "@mail/core/common/message";
import { rpc } from "@web/core/network/rpc";
import { toRaw } from "@odoo/owl";
import { MAIN_PLUGINS } from "@html_editor/plugin_sets";
import { MentionPlugin } from "@mail/views/web/fields/html_composer_message_field/mention_plugin";
import { CannedResponsePlugin } from "./canned_response_plugin";
import { _t } from "@web/core/l10n/translation";
import { useFileViewer } from "@web/core/file_viewer/file_viewer_hook";
import { Attachment } from "@mail/core/common/attachment_model";
import { FileViewer } from "@web/core/file_viewer/file_viewer";
import { loadJS } from "@web/core/assets";

patch(Attachment.prototype, {
    get isPdf() {
        return super.isPdf || 
               (this.mimetype && this.mimetype.includes("pdf")) || 
               (this.extension && String(this.extension).toLowerCase() === "pdf") || 
               (this.filename && String(this.filename).toLowerCase().endsWith(".pdf")) || 
               (this.name && String(this.name).toLowerCase().endsWith(".pdf"));
    },
    get isDocx() {
        return (this.mimetype && (this.mimetype.includes("wordprocessingml") || this.mimetype.includes("msword"))) || 
               (this.extension && String(this.extension).toLowerCase() === "docx") || 
               (this.filename && String(this.filename).toLowerCase().endsWith(".docx")) || 
               (this.name && String(this.name).toLowerCase().endsWith(".docx"));
    },
    get isXlsx() {
        return (this.mimetype && (this.mimetype.includes("spreadsheetml") || this.mimetype.includes("ms-excel"))) || 
               (this.extension && String(this.extension).toLowerCase() === "xlsx") || 
               (this.filename && String(this.filename).toLowerCase().endsWith(".xlsx")) || 
               (this.name && String(this.name).toLowerCase().endsWith(".xlsx"));
    },
    get isViewable() {
        return super.isViewable || ((this.isPdf || this.isDocx || this.isXlsx) && !this.uploading);
    }
});

Object.assign(Composer.components, { Wysiwyg });

// Patch the "Edit" action from the message dropdown to provide raw HTML 
// instead of plaintext if we're inside the chatter.
const editAction = messageActionsRegistry.get("edit");
if (editAction) {
    const originalEditOnClick = editAction.onClick;
    editAction.onClick = (component) => {
        if (!component.env.inChatWindow) {
            const message = toRaw(component.props.message);
            const text = message.body || "";
            message.composer = {
                mentionedPartners: message.recipients,
                text,
                selection: {
                    start: text.length,
                    end: text.length,
                    direction: "none",
                },
            };
            component.state.isEditing = true;
        } else {
            originalEditOnClick(component);
        }
    };
}

messageActionsRegistry.add("quote-reply", {
    condition: () => true,
    icon: "fa fa-quote-right",
    title: _t("Quote & Reply"),
    onClick: (component) => {
        const message = toRaw(component.props.message);
        const thread = toRaw(component.props.thread);
        if (thread && thread.composer) {
            const authorName = message.author ? message.author.name : _t("Someone");
            
            let cleanBody = message.body || "";

            // We use a div to bypass Read More, but we add a nice background and border to mimic a native quote
            // Setting contenteditable="false" makes the whole block behave like a single attachment, allowing 1-click deletion via Backspace
            const quoteHtml = `
                <div class="rich_text_quote" contenteditable="false" style="border-left: 4px solid #00A09D; background-color: rgba(0, 160, 157, 0.05); padding: 12px 15px; margin: 10px 0; border-radius: 0 8px 8px 0; color: #495057;">
                    <div class="text-truncate" style="font-size: 0.9em; margin-bottom: 8px; color: #00A09D; font-weight: 600;">
                        <i class="fa fa-reply me-1"></i> ${authorName} ${_t("wrote:")}
                    </div>
                    <div style="opacity: 0.9;">${cleanBody}</div>
                </div>
                <p><br></p>
            `;
            
            // Append the quote to the composer's current text
            const currentText = thread.composer.text || "";
            thread.composer.text = currentText + quoteHtml;
            
            // Force Odoo to open the "Send Message" tab instead of hiding it in Log Note
            const sendMessageBtn = document.querySelector('.o-mail-Chatter-sendMessage');
            if (sendMessageBtn && !sendMessageBtn.classList.contains('active')) {
                sendMessageBtn.click();
            }

            // Focus on the composer
            thread.composer.isFocused = true;
            // Scroll down
            const composerEl = document.querySelector('.o-mail-Composer');
            if (composerEl) {
                composerEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
        }
    },
    sequence: 55, // Places it nicely in the dropdown next to other actions
});

patch(Store.prototype, {
    async getMessagePostParams(args) {
        const params = await super.getMessagePostParams(args);
        if (args.postData && args.postData.isHtml) {
            let safeBody = (args.body || "").replace(/<!--[\s\S]*?-->/g, "");
            safeBody = safeBody.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(match) {
                const high = match.charCodeAt(0);
                const low = match.charCodeAt(1);
                const codePoint = ((high - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
                return `&#${codePoint};`;
            });
            params.post_data.body = `<div class="w-100">${safeBody}</div>`;
        }
        return params;
    }
});

patch(MessageModel.prototype, {
    async edit(body, attachments = [], args = {}) {
        // args is essentially { mentionedChannels, mentionedPartners, isHtml, ... }
        // We inject isHtml from the Composer patch below
        if (args.isHtml) {
            let safeBody = (body || "").replace(/<!--[\s\S]*?-->/g, "");
            safeBody = safeBody.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(match) {
                const high = match.charCodeAt(0);
                const low = match.charCodeAt(1);
                const codePoint = ((high - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
                return `&#${codePoint};`;
            });
            const finalBody = `<div class="w-100">${safeBody}</div>`;
            const validMentions = this.store.getMentionsFromText(body, {
                mentionedChannels: args.mentionedChannels,
                mentionedPartners: args.mentionedPartners,
            });
            const data = await rpc("/mail/message/update_content", {
                attachment_ids: attachments.concat(this.attachment_ids).map((a) => a.id),
                attachment_tokens: attachments.concat(this.attachment_ids).map((a) => a.access_token),
                body: finalBody,
                message_id: this.id,
                partner_ids: validMentions?.partners?.map((p) => p.id),
                ...this.thread.rpcParams,
            });
            this.store.insert(data, { html: true });
            if (this.hasLink && this.store.hasLinkPreviewFeature) {
                rpc("/mail/link_preview", { message_id: this.id }, { silent: true });
            }
            return data;
        }
        return super.edit(...arguments);
    }
});

patch(MessageComponent.prototype, {
    setup() {
        super.setup(...arguments);
        this.fileViewer = useFileViewer();
    },
    async onClick(ev) {
        const target = ev.target;
        
        // Helper to normalize URLs for comparison (relative vs absolute)
        const normalize = (u) => {
            if (!u) return "";
            try {
                const urlObj = new URL(u, window.location.origin);
                return urlObj.pathname + (urlObj.search || "");
            } catch (e) {
                return u;
            }
        };

        const attachmentsArray = Array.from(this.props.message.attachment_ids || []);

        // Handle Image clicks
        if (target.tagName === "IMG" && !target.closest(".o-mail-AttachmentImage") && !target.closest(".o-mail-Message-avatar")) {
            const targetSrc = normalize(target.getAttribute("src") || target.src).split("?")[0];
            const attachment = attachmentsArray.find(a => {
                const aUrl = normalize(a.url || a.downloadUrl || "").split("?")[0];
                return aUrl && (targetSrc.includes(aUrl) || aUrl.includes(targetSrc));
            });

            if (attachment) {
                ev.preventDefault();
                ev.stopPropagation();
                this.fileViewer.open(attachment, attachmentsArray.filter(a => a.isViewable));
            } else if (!target.closest(".o-mail-AttachmentCard")) {
                ev.preventDefault();
                ev.stopPropagation();
                this.fileViewer.open({
                    isViewable: true,
                    isImage: true,
                    mimetype: "image/png",
                    defaultSource: target.src,
                    downloadUrl: target.src,
                    displayName: target.alt || "Image",
                });
            }
            return;
        }

        // Handle inline PDF links (intercept download links for preview)
        const link = target.closest("a");
        const attachmentCard = target.closest(".o-mail-AttachmentCard");
        
        if (link && !attachmentCard) {
            const href = link.getAttribute("href") || "";
            const targetHref = normalize(href).split("?")[0];
            
            const attachment = attachmentsArray.find(a => {
                const aUrl = normalize(a.url || "").split("?")[0];
                const aDownloadUrl = normalize(a.downloadUrl || "").split("?")[0];
                return (targetHref && (aUrl === targetHref || aDownloadUrl === targetHref)) ||
                       (a.filename && link.innerText.includes(a.filename)) || 
                       (a.name && link.innerText.includes(a.name));
            });

            const linkText = link.innerText.trim().toLowerCase();
            const linkTitle = (link.getAttribute("title") || "").toLowerCase();
            const isPdfUrl = (u) => u && (/\.pdf($|\?|#)/i.test(u) || u.includes("application%2Fpdf") || u.includes("application/pdf"));
            const isDocxUrl = (u) => u && /\.docx($|\?|#)/i.test(u);
            const isXlsxUrl = (u) => u && /\.xlsx($|\?|#)/i.test(u);
            
            const isPreviewableDoc = (attachment && (attachment.isPdf || attachment.isDocx || attachment.isXlsx)) || 
                                     isPdfUrl(href) || isDocxUrl(href) || isXlsxUrl(href) || 
                                     linkText.match(/\.(pdf|docx|xlsx)$/) || linkTitle.match(/\.(pdf|docx|xlsx)$/) || 
                                     (target.dataset && (target.dataset.mimetype === "application/pdf" || target.dataset.mimetype?.includes("wordprocessingml") || target.dataset.mimetype?.includes("spreadsheetml"))) || 
                                     link.querySelector('[data-mimetype="application/pdf"], [data-mimetype*="wordprocessingml"], [data-mimetype*="spreadsheetml"]');

            if (isPreviewableDoc) {
                ev.preventDefault();
                ev.stopPropagation();

                if (attachment) {
                    this.fileViewer.open(attachment, attachmentsArray.filter(a => a.isViewable));
                } else {
                    const absoluteUrl = link.href;
                    let viewerUrl = absoluteUrl;
                    try {
                        const urlObj = new URL(absoluteUrl, window.location.origin);
                        if (urlObj.origin === window.location.origin) {
                            viewerUrl = urlObj.pathname + urlObj.search;
                        }
                    } catch (e) {}

                    // Strip `download=true` so the viewer itself doesn't force a browser download
                    viewerUrl = viewerUrl.replace(/([&?])download=(true|1)/gi, "");
                    // Clean up trailing ? or &
                    viewerUrl = viewerUrl.replace(/[&?]$/, "");

                    // Determine type flag based on extension or title
                    const forceDocx = isDocxUrl(href) || linkText.endsWith(".docx") || linkTitle.endsWith(".docx");
                    const forceXlsx = isXlsxUrl(href) || linkText.endsWith(".xlsx") || linkTitle.endsWith(".xlsx");

                    // Create a dummy record that matches FileModelMixin interface
                    const virtualAttachment = {
                        isViewable: true,
                        isPdf: !forceDocx && !forceXlsx,
                        isDocx: forceDocx,
                        isXlsx: forceXlsx,
                        type: "url",
                        url: viewerUrl,
                        name: name,
                        filename: name,
                        downloadUrl: absoluteUrl,
                        displayName: name,
                        defaultSource: (!forceDocx && !forceXlsx) ? `/web/static/lib/pdfjs/web/viewer.html?file=${encodeURIComponent(viewerUrl)}#pagemode=none` : viewerUrl,
                        urlRoute: viewerUrl,
                        urlQueryParams: {}
                    };
                    this.fileViewer.open(virtualAttachment, [virtualAttachment]);
                }
                return;
            }
        }

        return super.onClick(...arguments);
    }
});

patch(Composer.prototype, {
    setup() {
        super.setup(...arguments);
        this.wysiwygEditor = null;
        this.boundOnInput = this.onWysiwygInput.bind(this);
    },

    getWysiwygConfig() {
        // Strip the wrapping div when loading back into the editor if present
        let content = this.props.composer.text || "";
        content = content.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
        
        return {
            content: content,
            allowCommandVideo: false,
            placeholder: this.placeholder,
            disableFloatingToolbar: false,
            onChange: this.boundOnInput,
            Plugins: [...MAIN_PLUGINS, MentionPlugin, CannedResponsePlugin],
            thread: this.props.composer.thread,
            isLog: this.props.type === 'note', // Pass composer mode downstream
        };
    },

    get postData() {
        const res = super.postData;
        res.isHtml = !!this.wysiwygEditor && !this.env.inChatWindow;
        return res;
    },

    async editMessage() {
        const isHtml = !!this.wysiwygEditor && !this.env.inChatWindow;
        if (isHtml && !this.askDeleteFromEdit) {
            const composer = toRaw(this.props.composer);
            await this.processMessage(async (value) =>
                composer.message.edit(value, composer.attachments, {
                    mentionedChannels: composer.mentionedChannels,
                    mentionedPartners: composer.mentionedPartners,
                    isHtml: true,
                })
            );
            this.suggestion?.clearRawMentions();
        } else {
            return super.editMessage(...arguments);
        }
    },

    onWysiwygInput() {
        if (!this.wysiwygEditor) {
            return;
        }
        let htmlStr = "";
        try {
            if (typeof this.wysiwygEditor.getContent === "function") {
                htmlStr = this.wysiwygEditor.getContent();
            } else if (typeof this.wysiwygEditor.getElContent === "function") {
                htmlStr = this.wysiwygEditor.getElContent().innerHTML;
            } else if (this.wysiwygEditor.editable) {
                htmlStr = this.wysiwygEditor.editable.innerHTML;
            }
        } catch (e) {
            console.error("Error getting content from Wysiwyg editor:", e);
            return;
        }
        
        if (this.props.composer.text !== htmlStr) {
            this.props.composer.text = htmlStr;
        }
    },

    onWysiwygLoad(editor) {
        this.wysiwygEditor = editor;
    },

    onWysiwygBlur() {
        if (this.props.composer) {
            // Delay a bit to allow click events on buttons to process before losing focus state
            setTimeout(() => {
                if (this.props.composer) {
                    this.props.composer.isFocused = false;
                }
            }, 150);
        }
    },
    
    clear() {
        super.clear(...arguments);
        if (this.wysiwygEditor && this.wysiwygEditor.editable && !this.env.inChatWindow) {
            this.wysiwygEditor.editable.innerHTML = "";
            this.props.composer.text = "";
        }
    }
});

patch(FileViewer.prototype, {
    setup() {
        super.setup(...arguments);
        this.state.isLoadingCustomView = false;
        
        owl.onMounted(() => {
            this.loadCustomFileView();
        });
    },

    activateFile(index) {
        super.activateFile(index);
        this.loadCustomFileView();
    },

    async loadCustomFileView() {
        if (!this.state.file.isDocx && !this.state.file.isXlsx) return;
        
        this.state.isLoadingCustomView = true;
        try {
            await new Promise(r => setTimeout(r, 50));
            // Locate the container placed by our XML patch
            const container = document.querySelector('.docx-xlsx-viewer');
            if (!container) return;
            
            const loadingHtml = `<div class="d-flex flex-column w-100 h-100 align-items-center justify-content-center">
                <i class="fa fa-3x fa-circle-o-notch fa-spin text-muted mb-3" role="img"></i>
                <span class="text-muted">${_t("Loading preview / assets...")}</span>
            </div>`;
            container.innerHTML = loadingHtml;

            // Dynamically load the necessary libraries so we don't bloat Odoo's initial load
            if (this.state.file.isXlsx && typeof window.XLSX === 'undefined') {
                await loadJS("/rich_text_chatter/static/lib/xlsx.full.min.js");
            } else if (this.state.file.isDocx && typeof window.mammoth === 'undefined') {
                await loadJS("/rich_text_chatter/static/lib/mammoth.browser.min.js");
            }

            const url = this.state.file.defaultSource || `/web/content/${this.state.file.id}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error("Fetch failed");
            
            const arrayBuffer = await response.arrayBuffer();
            
            if (this.state.file.isXlsx && typeof window.XLSX !== 'undefined') {
                const workbook = window.XLSX.read(arrayBuffer, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const html = window.XLSX.utils.sheet_to_html(worksheet, { id: "data-table", editable: false });
                
                // Add some basic styling to make the sheet look nice
                const htmlWithStyle = `
                    <style>
                        #data-table { border-collapse: collapse; width: 100%; font-size: 14px; }
                        #data-table td, #data-table th { border: 1px solid #dee2e6; padding: 6px 10px; }
                        #data-table tr:first-child { background-color: #f8f9fa; font-weight: bold; }
                    </style>
                    ${html}
                `;
                container.innerHTML = htmlWithStyle;
                
            } else if (this.state.file.isDocx && typeof window.mammoth !== 'undefined') {
                const result = await window.mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
                container.innerHTML = `<div class="mammoth-content" style="max-width: 800px; margin: auto; padding: 20px; font-size: 15px; color: #333; line-height: 1.6;">${result.value}</div>`;
                if (result.messages && result.messages.length > 0) {
                    console.log("Mammoth messages:", result.messages);
                }
            } else {
                container.innerHTML = `<div class='alert alert-warning m-4'>${_t("Required library not loaded. Refresh the page to load assets.")}</div>`;
            }
        } catch (error) {
            console.error("Preview rendering error:", error);
            const container = document.querySelector('.docx-xlsx-viewer');
            if (container) container.innerHTML = `<div class='alert alert-danger m-4'>${_t("Failed to load document preview.")} <br/><small>\${error.message}</small></div>`;
        } finally {
            this.state.isLoadingCustomView = false;
        }
    }
});

patch(MessageComponent.prototype, {
    prepareMessageBody(bodyEl) {
        super.prepareMessageBody(bodyEl);
        // Odoo natively truncates email quotes and blockquotes behind a "Read More".
        // The user requested that these quotes should be EXPANDED by default, allowing 
        // a "Read Less" option instead.
        // We simulate a click on all "Read More" buttons to expand them on initial load.
        setTimeout(() => {
            if (this.messageBody && this.messageBody.el) {
                const readMoreLinks = this.messageBody.el.querySelectorAll('.o-mail-read-more-less');
                readMoreLinks.forEach(link => {
                    if (link.textContent.includes('Read More')) {
                        link.click();
                    }
                });
            }
        }, 0);
    }
});

