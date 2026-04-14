/** @odoo-module */
import { _t } from "@web/core/l10n/translation";
import { Component, useEffect, useState } from "@odoo/owl";
import { useService, useAutofocus } from "@web/core/utils/hooks";
import { NavigableList } from "@mail/core/common/navigable_list";
import { useSequential } from "@mail/utils/common/hooks";

export class CannedResponseList extends Component {
    static template = "rich_text_chatter.CannedResponseList";
    static components = { NavigableList };
    static props = {
        onSelect: { type: Function },
        close: { type: Function, optional: true },
        thread: { optional: true },
        isLog: { type: Boolean, optional: true }
    };
    static defaultProps = {
        close: () => {},
    };

    setup() {
        super.setup();
        this.state = useState({
            searchTerm: "",
            options: [],
            isFetching: false,
        });
        this.suggestionService = useService("mail.suggestion");
        this.sequential = useSequential();
        this.ref = useAutofocus({ mobile: true });

        useEffect(
            (term, thread) => {
                this.sequential(async () => {
                    this.state.isFetching = true;
                    try {
                        await this.suggestionService.fetchSuggestions({ delimiter: ":", term });
                    } finally {
                        this.state.isFetching = false;
                    }
                    const { suggestions } = this.suggestionService.searchSuggestions(
                        { delimiter: ":", term },
                        { sort: true, thread }
                    );
                    
                    const isLog = this.props.isLog;
                    this.state.options = (suggestions || []).filter(s => {
                        if (!s.usage_type || s.usage_type === 'all') return true;
                        if (isLog && s.usage_type === 'note') return true;
                        if (!isLog && s.usage_type === 'message') return true;
                        return false;
                    });
                });
            },
            () => [this.state.searchTerm, this.props.thread, this.props.isLog]
        );
    }

    get placeholder() {
        return _t("Search canned responses...");
    }

    get navigableListProps() {
        return {
            anchorRef: this.ref.el,
            position: "bottom-fit",
            isLoading: !!this.state.searchTerm && this.state.isFetching,
            onSelect: (...args) => {
                this.props.onSelect(...args);
                this.props.close();
            },
            autoSelectFirst: false,
            optionTemplate: "mail.Composer.suggestionCannedResponse",
            options: this.state.options.map((suggestion) => {
                return {
                    cannedResponse: suggestion,
                    source: suggestion.source,
                    label: suggestion.substitution,
                    classList: "o-mail-Composer-suggestion",
                };
            }),
        };
    }

    onKeydown(ev) {
        if (ev.key === "Escape") {
            this.props.close();
        }
    }
}
