import template from './sw-category-tree.html.twig';
import './sw-category-tree.scss';

const { Component } = Shopware;
const { Criteria } = Shopware.Data;
const { mapState } = Shopware.Component.getComponentHelper();

Component.register('sw-category-tree', {
    template,

    inject: ['repositoryFactory', 'syncService'],

    mixins: ['notification'],

    props: {
        categoryId: {
            type: String,
            required: false,
            default: null
        },

        currentLanguageId: {
            type: String,
            required: true
        },

        allowEdit: {
            type: Boolean,
            required: false,
            default: true
        },

        allowCreate: {
            type: Boolean,
            required: false,
            default: true
        },

        allowDelete: {
            type: Boolean,
            required: false,
            default: true
        }
    },

    data() {
        return {
            loadedCategories: {},
            translationContext: 'sw-category',
            linkContext: 'sw.category.detail',
            isLoadingInitialData: true,
            loadedParentIds: []
        };
    },

    created() {
        this.createdComponent();
    },

    computed: {
        ...mapState('swCategoryDetail', [
            'categoriesToDelete'
        ]),

        categoryRepository() {
            return this.repositoryFactory.create('category');
        },

        category() {
            return Shopware.State.get('swCategoryDetail').category;
        },

        categories() {
            return Object.values(this.loadedCategories);
        },

        disableContextMenu() {
            if (!this.allowEdit) {
                return true;
            }

            return this.currentLanguageId !== Shopware.Context.api.systemLanguageId;
        },

        contextMenuTooltipText() {
            if (!this.allowEdit) {
                return this.$tc('sw-privileges.tooltip.warning');
            }

            return null;
        },

        criteria() {
            return new Criteria(1, 500)
                .addAssociation('navigationSalesChannels')
                .addAssociation('footerSalesChannels')
                .addAssociation('serviceSalesChannels');
        },

        criteriaWithChildren() {
            const parentCriteria = Criteria.fromCriteria(this.criteria).setLimit(1);
            parentCriteria.associations.push({
                association: 'children',
                criteria: Criteria.fromCriteria(this.criteria)
            });

            return parentCriteria;
        }
    },

    watch: {
        categoriesToDelete(value) {
            if (value === undefined) {
                return;
            }

            this.$refs.categoryTree.onDeleteElements(value);

            Shopware.State.commit('swCategoryDetail/setCategoriesToDelete', {
                categoriesToDelete: undefined
            });
        },

        category(newVal, oldVal) {
            // load data when path is available
            if (!oldVal && this.isLoadingInitialData) {
                this.openInitialTree();
                return;
            }

            // back to index
            if (newVal === null) {
                return;
            }

            // reload after save
            if (oldVal && newVal.id === oldVal.id) {
                this.categoryRepository.get(newVal.id, Shopware.Context.api).then((newCategory) => {
                    this.loadedCategories[newCategory.id] = newCategory;
                    this.loadedCategories = { ...this.loadedCategories };
                });
            }
        },

        currentLanguageId() {
            this.openInitialTree();
        }
    },

    methods: {
        createdComponent() {
            if (this.category !== null) {
                this.openInitialTree();
            }

            if (!this.categoryId) {
                this.loadRootCategories().finally(() => {
                    this.isLoadingInitialData = false;
                });
            }
        },

        openInitialTree() {
            this.isLoadingInitialData = true;
            this.loadedCategories = {};
            this.loadedParentIds = [];

            this.loadRootCategories()
                .then(() => {
                    if (!this.category || this.category.path === null) {
                        this.isLoadingInitialData = false;
                        return Promise.resolve();
                    }

                    const parentIds = this.category.path.split('|').filter((id) => !!id);
                    const parentPromises = [];

                    parentIds.forEach((id) => {
                        const promise = this.categoryRepository.get(id, Shopware.Context.api, this.criteriaWithChildren)
                            .then((result) => {
                                this.addCategories([result, ...result.children]);
                            });
                        parentPromises.push(promise);
                    });

                    return Promise.all(parentPromises).then(() => {
                        this.isLoadingInitialData = false;
                    });
                });
        },

        onUpdatePositions({ draggedItem, oldParentId, newParentId }) {
            if (draggedItem.children.length > 0) {
                draggedItem.children.forEach((child) => {
                    this.removeFromStore(child.id);
                });
                this.loadedParentIds = this.loadedParentIds.filter((id) => id !== draggedItem.id);
            }

            this.syncSiblings({ parentId: newParentId }).then(() => {
                if (oldParentId !== newParentId) {
                    this.syncSiblings({ parentId: oldParentId });
                }
            });
        },

        checkedElementsCount(count) {
            this.$emit('category-checked-elements-count', count);
        },

        deleteCheckedItems(checkedItems) {
            const ids = Object.keys(checkedItems);

            const hasNavigationCategories = ids.some((id) => {
                return this.loadedCategories[id].navigationSalesChannels !== null
                    && this.loadedCategories[id].navigationSalesChannels.length > 0;
            });

            if (hasNavigationCategories) {
                this.createNotificationError({
                    message: this.$tc('sw-category.general.errorNavigationEntryPointMultiple')
                });

                const categories = ids.map((id) => {
                    return this.loadedCategories[id];
                });

                // reload to remove selection
                ids.forEach((deleted) => {
                    this.$delete(this.loadedCategories, deleted);
                });
                this.$nextTick(() => {
                    this.addCategories(categories);
                });

                return;
            }

            this.categoryRepository.syncDeleted(ids, Shopware.Context.api).then(() => {
                ids.forEach(id => this.removeFromStore(id));
            });
        },

        onDeleteCategory({ data: category, children }) {
            if (category.isNew()) {
                this.$delete(this.loadedCategories, category.id);
                return Promise.resolve();
            }

            if (category.navigationSalesChannels !== null && category.navigationSalesChannels.length > 0) {
                // remove delete flags
                category.isDeleted = false;
                if (children.length > 0) {
                    children.forEach((child) => {
                        child.data.isDeleted = false;
                    });
                }

                // reinsert category in sorting because the tree
                // already overwrites the afterCategoryId of the following category
                const next = Object.values(this.loadedCategories).find((item) => {
                    return item.parentId === category.parentId && item.afterCategoryId === category.afterCategoryId;
                });
                if (next !== null) {
                    next.afterCategoryId = category.id;
                }

                // reload after changes
                this.loadedCategories = { ...this.loadedCategories };

                this.createNotificationError({ message: this.$tc('sw-category.general.errorNavigationEntryPoint') });
                return Promise.resolve();
            }

            return this.categoryRepository.delete(category.id, Shopware.Context.api).then(() => {
                this.removeFromStore(category.id);

                if (category.parentId !== null) {
                    this.categoryRepository.get(category.parentId, Shopware.Context.api).then((updatedParent) => {
                        this.addCategory(updatedParent);
                    });
                }

                if (category.id === this.categoryId) {
                    this.$router.push({ name: 'sw.category.index' });
                }
            });
        },

        changeCategory(category) {
            const route = { name: 'sw.category.detail', params: { id: category.id } };
            if (this.category && this.categoryRepository.hasChanges(this.category)) {
                this.$emit('unsaved-changes', route);
            } else {
                this.$router.push(route);
            }
        },

        onGetTreeItems(parentId) {
            if (this.loadedParentIds.includes(parentId)) {
                return Promise.resolve();
            }

            this.loadedParentIds.push(parentId);
            const criteria = Criteria.fromCriteria(this.criteria)
                .addFilter(Criteria.equals('parentId', parentId));

            return this.categoryRepository.search(criteria, Shopware.Context.api).then((children) => {
                this.addCategories(children);
            }).catch(() => {
                this.loadedParentIds = this.loadedParentIds.filter((id) => {
                    return id !== parentId;
                });
            });
        },

        getChildrenFromParent(parentId) {
            return this.onGetTreeItems(parentId);
        },

        loadRootCategories() {
            const criteria = Criteria.fromCriteria(this.criteria)
                .addFilter(Criteria.equals('parentId', null));

            return this.categoryRepository.search(criteria, Shopware.Context.api).then((result) => {
                this.addCategories(result);
            });
        },

        createNewElement(contextItem, parentId, name = '') {
            if (!parentId && contextItem) {
                parentId = contextItem.parentId;
            }
            const newCategory = this.createNewCategory(name, parentId);
            this.addCategory(newCategory);
            return newCategory;
        },

        createNewCategory(name, parentId) {
            const newCategory = this.categoryRepository.create(Shopware.Context.api);

            newCategory.name = name;
            newCategory.parentId = parentId;
            newCategory.childCount = 0;
            newCategory.active = false;
            newCategory.visible = true;

            newCategory.save = () => {
                return this.categoryRepository.save(newCategory, Shopware.Context.api).then(() => {
                    const criteria = Criteria.fromCriteria(this.criteria)
                        .setIds([newCategory.id, parentId].filter((id) => id !== null));
                    this.categoryRepository.search(criteria, Shopware.Context.api).then((categories) => {
                        this.addCategories(categories);
                    });
                });
            };

            return newCategory;
        },

        syncSiblings({ parentId }) {
            const siblings = this.categories.filter((category) => {
                return category.parentId === parentId;
            });

            return this.categoryRepository.sync(siblings, Shopware.Context.api).then(() => {
                this.loadedParentIds = this.loadedParentIds.filter(id => id !== parentId);
                return this.getChildrenFromParent(parentId);
            }).then(() => {
                this.categoryRepository.get(parentId, Shopware.Context.api).then((parent) => {
                    this.addCategory(parent);
                });
            });
        },

        addCategory(category) {
            if (!category) {
                return;
            }

            this.$set(this.loadedCategories, category.id, category);
        },

        addCategories(categories) {
            categories.forEach((category) => {
                this.$set(this.loadedCategories, category.id, category);
            });
        },

        removeFromStore(id) {
            const deletedIds = this.getDeletedIds(id);
            this.loadedParentIds = this.loadedParentIds.filter((loadedId) => {
                return !deletedIds.includes(loadedId);
            });

            deletedIds.forEach((deleted) => {
                this.$delete(this.loadedCategories, deleted);
            });
        },

        getDeletedIds(idToDelete) {
            const idsToDelete = [idToDelete];
            Object.keys(this.loadedCategories).forEach((id) => {
                const currentCategory = this.loadedCategories[id];
                if (currentCategory.parentId === idToDelete) {
                    idsToDelete.push(...this.getDeletedIds(id));
                }
            });
            return idsToDelete;
        },

        getCategoryUrl(category) {
            return this.$router.resolve({
                name: this.linkContext,
                params: { id: category.id }
            }).href;
        },

        isHighlighted(item) {
            return (item.data.navigationSalesChannels !== null && item.data.navigationSalesChannels.length > 0)
                || (item.data.serviceSalesChannels !== null && item.data.serviceSalesChannels.length > 0)
                || (item.data.footerSalesChannels !== null && item.data.footerSalesChannels.length > 0);
        }
    }
});
