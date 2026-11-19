import {redirect} from "next/navigation";

/** Legacy Excel v1 view has been retired; old bookmarks open the single v2 workflow. */
export default function IndividualPage(){
 redirect("/weekly-v2");
}
