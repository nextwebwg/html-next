export const entries = () => [{ slug: "one" }, { slug: "two" }];
export const load = ({ params }) => ({ props: { label: "Item " + params.slug }, head: { title: "Item " + params.slug } });
