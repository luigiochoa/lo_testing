/** @odoo-module */
import { Plugin } from "@html_editor/plugin";
import { CannedResponseList } from "./canned_response_list";

export class CannedResponsePlugin extends Plugin {
    static id = "canned_response";
    static dependencies = ["overlay", "dom", "history", "input", "selection"];

    resources = {
        beforeinput_handlers: this.onBeforeInput.bind(this),
    };

    setup() {
        this.cannedList = this.dependencies.overlay.createOverlay(CannedResponseList, {
            hasAutofocus: true,
            className: "popover o-mail-MentionPlugin-overlay",
        });
    }

    onSelect(ev, option) {
        this.dependencies.selection.focusEditable();
        
        const fragment = this.document.createDocumentFragment();
        const tempDiv = this.document.createElement("div");
        let substitutionHtml = option.cannedResponse.substitution || "";
        // Convert plain text line breaks to HTML breaks only if it doesn't already contain HTML tags
        if (!/<[a-z][\s\S]*>/i.test(substitutionHtml)) {
            substitutionHtml = substitutionHtml.replace(/\r?\n/g, "<br/>");
        }
        tempDiv.innerHTML = substitutionHtml + "&nbsp;";
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }

        // Restore cursor to right before ':' and replace it
        this.historySavePointRestore();
        this.dependencies.dom.insert(fragment);
        this.dependencies.history.addStep();
    }

    onBeforeInput(ev) {
        if (ev.data === ":") {
            this.historySavePointRestore = this.dependencies.history.makeSavePoint();
            this.cannedList.open({
                props: {
                    onSelect: this.onSelect.bind(this),
                    thread: this.config.thread,
                    isLog: this.config.isLog,
                    close: () => {
                        this.cannedList.close();
                    },
                },
            });
        }
    }
}
