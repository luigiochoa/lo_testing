/** @odoo-module */

import { Composer } from "@mail/core/common/composer";
import { Wysiwyg } from "@html_editor/wysiwyg";
import { patch } from "@web/core/utils/patch";
import { Store } from "@mail/core/common/store_service";
import { messageActionsRegistry } from "@mail/core/common/message_actions";
import { Message as MessageModel } from "@mail/core/common/message_model";
import { Message as MessageComponent } from "@mail/core/common/message";
import { rpc } from "@web/core/network/rpc";
import { toRaw, onWillUnmount } from "@odoo/owl";
import { MAIN_PLUGINS } from "@html_editor/plugin_sets";
import { Plugin } from "@html_editor/plugin";
import { MentionPlugin } from "@mail/views/web/fields/html_composer_message_field/mention_plugin";
import { CannedResponsePlugin } from "./canned_response_plugin";
import { _t } from "@web/core/l10n/translation";
import { useFileViewer } from "@web/core/file_viewer/file_viewer_hook";
import { FileViewer } from "@web/core/file_viewer/file_viewer";
import { loadJS } from "@web/core/assets";

// Remove the dangerous Attachment patch that broke image isViewable.
// We will patch AttachmentCard instead to handle DOCX/XLSX viewability.
Object.assign(Composer.components, { Wysiwyg });

export class ChatterEscapePlugin extends Plugin {
    static id = "chatterEscape";
    static dependencies = [];

    setup() {
        // We use a document listener in capture mode to ensure we catch all shortcuts
        // before the editor's internal state can swallow them.
        this.addDomListener(this.document, "keydown", this.onKeydown, true);
    }

    onKeydown(ev) {
        // Only handle if the editable is the active element or contains it
        if (!this.editable.contains(this.document.activeElement) && this.editable !== this.document.activeElement) {
            return;
        }

        if (ev.key === "Escape") {
            if (this.config.onDiscardCallback) {
                ev.preventDefault();
                ev.stopImmediatePropagation();
                this.config.onDiscardCallback(ev);
            }
        } else if (ev.key === "ArrowUp") {
            const composer = toRaw(this.config.thread?.composer);
            if (this.config.thread && this.config.messageEdition && composer && composer.text === "") {
                const messageToEdit = this.config.thread.lastEditableMessageOfSelf;
                if (messageToEdit) {
                    ev.preventDefault();
                    ev.stopImmediatePropagation();
                    this.config.messageEdition.editingMessage = messageToEdit;
                }
            }
        } else if (ev.key === "Enter") {
            // Replicate Odoo's native Enter logic
            // mode === 'extended' (Chatter) -> requires Ctrl/Meta + Enter
            // mode === 'compact' (Chat Window) -> Enter sends, Shift+Enter for new line
            const isExtended = this.config.mode === "extended";
            const shouldPost = isExtended ? (ev.ctrlKey || ev.metaKey) : !ev.shiftKey;
            
            if (shouldPost) {
                ev.preventDefault();
                ev.stopImmediatePropagation();
                // Sync content before sending
                if (this.config.onInput) {
                    this.config.onInput();
                }
                const composer = toRaw(this.config.thread?.composer);
                if (composer && composer.message) {
                    if (this.config.editMessage) {
                        this.config.editMessage();
                    }
                } else if (this.config.sendMessage) {
                    this.config.sendMessage();
                }
            }
        }
    }
}

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
                message: message,
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
            
            // Append the quote to the composer's current text model
            const currentText = thread.composer.text || "";
            thread.composer.text = currentText + quoteHtml;
            
            // Force Odoo to open the "Send Message" tab instead of hiding it in Log Note
            const chatterEl = component.env.inChatWindow ? null : document.querySelector('.o-mail-Chatter');
            const sendMessageBtn = chatterEl ? chatterEl.querySelector('.o-mail-Chatter-sendMessage') : document.querySelector('.o-mail-Chatter-sendMessage');
            
            if (sendMessageBtn && !sendMessageBtn.classList.contains('active')) {
                sendMessageBtn.click();
            }

            // Dispatch an event to update the Wysiwyg component if it's already mounted
            window.dispatchEvent(new CustomEvent("rich_text_insert_quote", {
                detail: { 
                    threadId: thread.localId || thread.id, 
                    quoteHtml: quoteHtml 
                }
            }));

            // Focus on the composer and scroll it into view properly
            thread.composer.isFocused = true;
            setTimeout(() => {
                const composerEl = chatterEl ? chatterEl.querySelector('.o-mail-Composer') : document.querySelector('.o-mail-Composer');
                if (composerEl) {
                    // 'center' usually works better for the topbar composer so it doesn't get hidden under fixed headers
                    composerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
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

        // ─── Handle clicks on inline images in the message body ───
        const imgEl = target.closest("img");
        if (imgEl) {
            // Don't intercept images inside attachment cards (those are already handled by Odoo)
            const insideAttachmentList = target.closest(".o-mail-AttachmentList, .o-mail-AttachmentImage");
            if (!insideAttachmentList) {
                ev.preventDefault();
                ev.stopPropagation();

                const imgSrc = imgEl.getAttribute("src") || "";
                const normalizedImgSrc = normalize(imgSrc).split("?")[0];

                // Try to match against a real attachment from this message
                const matchingAttachment = attachmentsArray.find(a => {
                    if (!a.isImage) return false;
                    // Compare against various URL forms of the attachment
                    const aUrlRoute = normalize(`/web/image/${a.id}`).split("?")[0];
                    const aContentRoute = normalize(`/web/content/${a.id}`).split("?")[0];
                    const aUrl = normalize(a.url || "").split("?")[0];
                    return (
                        normalizedImgSrc === aUrlRoute ||
                        normalizedImgSrc === aContentRoute ||
                        normalizedImgSrc === aUrl ||
                        normalizedImgSrc.includes(`/web/image/${a.id}`) ||
                        normalizedImgSrc.includes(`/web/content/${a.id}`)
                    );
                });

                if (matchingAttachment) {
                    // Found a real attachment — open the FileViewer with all viewable attachments
                    const viewableAttachments = attachmentsArray.filter(a => a.isViewable);
                    this.fileViewer.open(matchingAttachment, viewableAttachments);
                } else {
                    // No matching attachment found — create a virtual one from the image src
                    let fullSrc = imgSrc;
                    try {
                        fullSrc = new URL(imgSrc, window.location.origin).href;
                    } catch (e) {}

                    const imgName = imgEl.getAttribute("alt") ||
                                    imgEl.getAttribute("title") ||
                                    imgSrc.split("/").pop().split("?")[0] ||
                                    _t("Image");

                    // Guess mimetype from the src URL or fall back to a safe default
                    const extMatch = imgSrc.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)(\?|$)/i);
                    const extToMime = {
                        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
                        bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
                    };
                    const mimetype = extMatch ? (extToMime[extMatch[1].toLowerCase()] || "image/png") : "image/png";

                    const virtualImage = {
                        isViewable: true,
                        isImage: true,
                        isPdf: false,
                        isText: false,
                        isVideo: false,
                        isUrlYoutube: false,
                        uploading: false,
                        type: "url",
                        mimetype: mimetype,
                        url: fullSrc,
                        name: imgName,
                        filename: imgName,
                        displayName: imgName,
                        downloadUrl: fullSrc,
                        defaultSource: fullSrc,
                        urlRoute: fullSrc,
                        urlQueryParams: {},
                    };

                    // Collect all inline images in the body so the user can navigate between them
                    const bodyEl = target.closest(".o-mail-Message-body");
                    const allInlineImages = bodyEl ? Array.from(bodyEl.querySelectorAll("img")) : [imgEl];
                    const virtualFiles = allInlineImages.map((img, idx) => {
                        if (img === imgEl) return virtualImage;
                        let src = img.getAttribute("src") || "";
                        try { src = new URL(src, window.location.origin).href; } catch (e) {}
                        const name = img.getAttribute("alt") || img.getAttribute("title") || src.split("/").pop().split("?")[0] || `Image ${idx + 1}`;
                        const ext = src.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)(\?|$)/i);
                        const mime = ext ? (extToMime[ext[1].toLowerCase()] || "image/png") : "image/png";
                        return {
                            isViewable: true, isImage: true, isPdf: false, isText: false,
                            isVideo: false, isUrlYoutube: false, uploading: false,
                            type: "url", mimetype: mime, url: src, name, filename: name,
                            displayName: name, downloadUrl: src, defaultSource: src,
                            urlRoute: src, urlQueryParams: {},
                        };
                    });
                    this.fileViewer.open(virtualImage, virtualFiles);
                }
                return;
            }
        }

        // ─── Handle inline links that point to viewable files (images, PDFs, DOCX, XLSX) ───
        const link = target.closest("a");
        const attachmentCard = target.closest(".o-mail-AttachmentCard");
        
        if (link && !attachmentCard) {
            const href = link.getAttribute("href") || "";
            const targetHref = normalize(href).split("?")[0];
            
            // Try to find a matching attachment record for this link
            const attachment = attachmentsArray.find(a => {
                const aUrl = normalize(a.url || "").split("?")[0];
                const aDownloadUrl = normalize(a.downloadUrl || "").split("?")[0];
                const aUrlRoute = normalize(`/web/content/${a.id}`).split("?")[0];
                const aImageRoute = normalize(`/web/image/${a.id}`).split("?")[0];
                return (targetHref && (
                    aUrl === targetHref || 
                    aDownloadUrl === targetHref || 
                    aUrlRoute === targetHref || 
                    aImageRoute === targetHref ||
                    targetHref.includes(`/web/content/${a.id}`) ||
                    targetHref.includes(`/web/image/${a.id}`)
                )) ||
                       (a.filename && link.innerText.includes(a.filename)) || 
                       (a.name && link.innerText.includes(a.name));
            });

            const linkText = link.innerText.trim().toLowerCase();
            const linkTitle = (link.getAttribute("title") || "").toLowerCase();
            
            // URL detection helpers
            const isPdfUrl = (u) => u && (/\.pdf($|\?|#)/i.test(u) || u.includes("application%2Fpdf") || u.includes("application/pdf"));
            const isDocxUrl = (u) => u && /\.docx($|\?|#)/i.test(u);
            const isXlsxUrl = (u) => u && /\.xlsx($|\?|#)/i.test(u);
            const isImageUrl = (u) => u && /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)($|\?|#)/i.test(u);
            const isImageName = (text) => text && /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(text);
            
            // Check if the link points to a viewable file
            const isPreviewableDoc = (attachment && (attachment.isPdf || attachment.isDocx || attachment.isXlsx)) || 
                                     isPdfUrl(href) || isDocxUrl(href) || isXlsxUrl(href) || 
                                     linkText.match(/\.(pdf|docx|xlsx)$/) || linkTitle.match(/\.(pdf|docx|xlsx)$/) || 
                                     (target.dataset && (target.dataset.mimetype === "application/pdf" || target.dataset.mimetype?.includes("wordprocessingml") || target.dataset.mimetype?.includes("spreadsheetml"))) || 
                                     link.querySelector('[data-mimetype="application/pdf"], [data-mimetype*="wordprocessingml"], [data-mimetype*="spreadsheetml"]');

            // Check if this link points to an image (either matched attachment or URL/filename pattern)
            const isPreviewableImage = (attachment && attachment.isViewable && attachment.isImage) ||
                                       isImageUrl(href) || isImageName(linkText) || isImageName(linkTitle) ||
                                       (target.dataset && target.dataset.mimetype?.startsWith("image/")) ||
                                       // Odoo download links like /web/content/ID?download=true with image filenames
                                       (href.includes("/web/content/") && isImageName(linkText));

            if (isPreviewableDoc || isPreviewableImage) {
                ev.preventDefault();
                ev.stopPropagation();

                if (attachment && attachment.isViewable) {
                    // Open using the real attachment record
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

                    // Determine type flags
                    const forceDocx = isDocxUrl(href) || linkText.endsWith(".docx") || linkTitle.endsWith(".docx");
                    const forceXlsx = isXlsxUrl(href) || linkText.endsWith(".xlsx") || linkTitle.endsWith(".xlsx");
                    const forceImage = isPreviewableImage && !isPreviewableDoc;
                    
                    // Determine name from link text or URL
                    const fileName = link.innerText.trim() || link.getAttribute("title") || viewerUrl.split("/").pop().split("?")[0] || _t("File");

                    // Guess image mimetype if applicable
                    const extToMime = {
                        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
                        bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
                    };
                    let mimetype = "application/pdf";
                    if (forceImage) {
                        const extMatch = (href + linkText).match(/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)($|\?|#)/i);
                        mimetype = extMatch ? (extToMime[extMatch[1].toLowerCase()] || "image/png") : "image/png";
                    }

                    // Create a virtual record matching FileModelMixin interface
                    const virtualAttachment = {
                        isViewable: true,
                        isImage: forceImage,
                        isPdf: !forceDocx && !forceXlsx && !forceImage,
                        isDocx: forceDocx,
                        isXlsx: forceXlsx,
                        isText: false,
                        isVideo: false,
                        isUrlYoutube: false,
                        uploading: false,
                        type: "url",
                        mimetype: mimetype,
                        url: viewerUrl,
                        name: fileName,
                        filename: fileName,
                        downloadUrl: absoluteUrl,
                        displayName: fileName,
                        defaultSource: (!forceDocx && !forceXlsx && !forceImage) ? `/web/static/lib/pdfjs/web/viewer.html?file=${encodeURIComponent(viewerUrl)}#pagemode=none` : viewerUrl,
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
        
        // Listen to quote insertion from message actions
        this.boundOnQuoteInsert = (ev) => {
            const currentThread = this.props.composer && this.props.composer.thread;
            if (currentThread && (currentThread.localId || currentThread.id) === ev.detail.threadId) {
                if (this.wysiwygEditor && this.wysiwygEditor.editable) {
                    // Editor is already mounted, we must manually inject the HTML
                    const fragment = document.createDocumentFragment();
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = ev.detail.quoteHtml;
                    while (tempDiv.firstChild) {
                        fragment.appendChild(tempDiv.firstChild);
                    }
                    this.wysiwygEditor.editable.appendChild(fragment);
                    this.onWysiwygInput(); // update the text model
                    
                    // Move cursor to bottom
                    try {
                        const range = document.createRange();
                        const sel = window.getSelection();
                        range.selectNodeContents(this.wysiwygEditor.editable);
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    } catch(e) {}
                    
                    this.wysiwygEditor.editable.focus();
                }
            }
        };
        window.addEventListener("rich_text_insert_quote", this.boundOnQuoteInsert);
        
        onWillUnmount(() => {
            window.removeEventListener("rich_text_insert_quote", this.boundOnQuoteInsert);
        });
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
            Plugins: [...MAIN_PLUGINS, MentionPlugin, CannedResponsePlugin, ChatterEscapePlugin],
            onDiscardCallback: this.props.onDiscardCallback || null,
            messageEdition: this.props.messageEdition || null,
            sendMessage: () => this.sendMessage(),
            editMessage: () => this.editMessage(),
            onInput: () => this.onWysiwygInput(),
            mode: this.props.mode,
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

            // --- SYNC MENTIONS FROM HTML TO ODOO'S INTERNAL RECORD ---
            try {
                const doc = new DOMParser().parseFromString(htmlStr, "text/html");
                
                // Set mentioned Partners
                const partnerLinks = doc.querySelectorAll("a[data-oe-model='res.partner']");
                this.props.composer.mentionedPartners.length = 0; // Clear existing
                Array.from(partnerLinks).forEach(link => {
                    const id = parseInt(link.dataset.oeId);
                    if (!isNaN(id)) {
                        this.props.composer.mentionedPartners.add({ id, type: "partner" });
                    }
                });

                // Set mentioned Channels
                const channelLinks = doc.querySelectorAll("a[data-oe-model='discuss.channel']");
                this.props.composer.mentionedChannels.length = 0; // Clear existing
                Array.from(channelLinks).forEach(link => {
                    const id = parseInt(link.dataset.oeId);
                    if (!isNaN(id)) {
                        this.props.composer.mentionedChannels.add({ id, model: "discuss.channel" });
                    }
                });
            } catch (e) {
                console.error("Error syncing mentions from Html:", e);
            }
        }
    },

    onWysiwygKeydown(ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
            // Already handled by ChatterEscapePlugin, but added here as fallback
            this.onWysiwygInput();
            if (this.props.composer.message) {
                this.editMessage();
            } else {
                this.sendMessage();
            }
        } else if (ev.key === "Escape") {
            if (this.props.onDiscardCallback) {
                this.props.onDiscardCallback(ev);
            }
        }
    },

    onWysiwygLoad(editor) {
        this.wysiwygEditor = editor;
        if ((this.props.autofocus || this.props.composer.message) && this.wysiwygEditor) {
            // Robust focus strategy: poll slightly until the element is actually in the DOM and visible
            let attempts = 0;
            const forceFocus = () => {
                attempts++;
                const editable = this.wysiwygEditor.editable;
                if (editable && document.body.contains(editable)) {
                    editable.focus();
                    // Simulate interaction to wake up plugins
                    editable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    
                    // If editing, move cursor to the end
                    if (this.props.composer.message) {
                        try {
                            const range = document.createRange();
                            const sel = window.getSelection();
                            range.selectNodeContents(editable);
                            range.collapse(false);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        } catch (e) {
                            console.warn("Could not set selection:", e);
                        }
                    }
                } else if (attempts < 20) {
                    setTimeout(forceFocus, 50);
                }
            };
            forceFocus();
        }
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

